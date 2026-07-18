//! Local Merkle proof verifier — no network calls, no I/O.
//!
//! Byte-compatible port of the `@capix/merkle` TypeScript reference
//! implementation (capix-merkle/v1 spec). The proof package (ProofJSON) is
//! fetched from the Capix API, but the cryptographic verification itself is
//! performed locally: this module recomputes the leaf hash, walks the sibling
//! path, and compares against the expected root.
//!
//! Security:
//!  - NEVER makes a network call.
//!  - NEVER logs leaf field values or customer data.
//!  - Returns `false` for any malformed proof (never panics on bad input).
//!  - Throws/returns errors only for programmer-level misuse.

use sha2::{Digest, Sha256};

// ──────────────────────────────────────────────────────────────────────────
// §2.2 Domain separation tags (ASCII bytes, no trailing NUL)
// ──────────────────────────────────────────────────────────────────────────

const LEAF_DOMAIN: &[u8] = b"capix:merkle:leaf:v1";
const NODE_DOMAIN: &[u8] = b"capix:merkle:node:v1";

/// Current leaf version for capix-merkle/v1.
const LEAF_VERSION: u32 = 1;

// ──────────────────────────────────────────────────────────────────────────
// §3.1 / §3.2 / §3.3 Primitive writers
// ──────────────────────────────────────────────────────────────────────────

fn write_u32_le(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

// u64 little-endian → 8 bytes.
fn write_u64_le(value: u64) -> [u8; 8] {
    value.to_le_bytes()
}

// ──────────────────────────────────────────────────────────────────────────
// §3.4 Canonical field-list encoder
// ──────────────────────────────────────────────────────────────────────────

/// field_kind discriminator bytes (spec §3.4).
pub mod field_kind {
    pub const HASH: u8 = 0x01;
    pub const U64: u8 = 0x02;
    pub const STRING: u8 = 0x03;
    pub const BYTES: u8 = 0x04;
    pub const NULL: u8 = 0x05;
    pub const U8: u8 = 0x06;
    pub const BOOL: u8 = 0x07;
}

/// A single canonical leaf field, decoded from the proof JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum Field {
    /// Fixed 32-byte hash / key (written raw, no length prefix).
    Hash([u8; 32]),
    /// Unsigned 64-bit little-endian integer.
    U64(u64),
    /// Length-prefixed (u32 LE) UTF-8 string.
    String(String),
    /// Length-prefixed (u32 LE) variable bytes.
    Bytes(Vec<u8>),
    /// Optional-absent marker (field_kind 0x05, no body).
    Null,
    /// 1-byte flag / enum.
    U8(u8),
    /// 1 byte boolean (0/1).
    Bool(bool),
}

/// Encode a single field as `field_kind:u8 ‖ value` into the sink.
fn encode_field(field: &Field, out: &mut Vec<u8>) {
    match field {
        Field::Hash(value) => {
            out.push(field_kind::HASH);
            out.extend_from_slice(value);
        }
        Field::U64(value) => {
            out.push(field_kind::U64);
            out.extend_from_slice(&write_u64_le(*value));
        }
        Field::String(value) => {
            out.push(field_kind::STRING);
            let body = value.as_bytes();
            out.extend_from_slice(&write_u32_le(body.len() as u32));
            out.extend_from_slice(body);
        }
        Field::Bytes(value) => {
            out.push(field_kind::BYTES);
            out.extend_from_slice(&write_u32_le(value.len() as u32));
            out.extend_from_slice(value);
        }
        Field::Null => {
            out.push(field_kind::NULL);
        }
        Field::U8(value) => {
            out.push(field_kind::U8);
            out.push(*value);
        }
        Field::Bool(value) => {
            out.push(field_kind::BOOL);
            out.push(if *value { 1 } else { 0 });
        }
    }
}

/// Encode an ordered field list as the concatenation of `encode_field` for each.
fn encode_fields(fields: &[Field]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in fields {
        encode_field(f, &mut out);
    }
    out
}

// ──────────────────────────────────────────────────────────────────────────
// §2.1 / §4 Leaf hashing
// ──────────────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Hash a leaf body given the FULL field list (category already present as
/// field 0). Used by the verifier to recompute a leaf hash from a Proof.
///
/// `leaf_hash = H( LEAF_DOMAIN ‖ u32_le(leafVersion) ‖ enc(fields) )`
fn hash_leaf_body(leaf_version: u32, full_fields: &[Field]) -> [u8; 32] {
    let mut buf = Vec::new();
    buf.extend_from_slice(LEAF_DOMAIN);
    buf.extend_from_slice(&write_u32_le(leaf_version));
    buf.extend_from_slice(&encode_fields(full_fields));
    sha256(&buf)
}

// ──────────────────────────────────────────────────────────────────────────
// Byte / hex utilities
// ──────────────────────────────────────────────────────────────────────────

/// Decode a lowercase hex string into 32 bytes. Returns `None` on any
/// malformed input (odd length, non-hex chars, wrong length).
fn from_hex_32(hex: &str) -> Option<[u8; 32]> {
    let bytes = hex_decode(hex)?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// Decode any hex string into bytes. Returns `None` on malformed input.
fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut chars = hex.chars();
    while let (Some(h), Some(l)) = (chars.next(), chars.next()) {
        out.push((hex_nibble(h)? << 4) | hex_nibble(l)?);
    }
    Some(out)
}

fn hex_nibble(c: char) -> Option<u8> {
    match c {
        '0'..='9' => Some(c as u8 - b'0'),
        'a'..='f' => Some(c as u8 - b'a' + 10),
        'A'..='F' => Some(c as u8 - b'A' + 10),
        _ => None,
    }
}

// ──────────────────────────────────────────────────────────────────────────
// §6 Proof JSON decoding
// ──────────────────────────────────────────────────────────────────────────

/// A sibling-hash proof step.
#[derive(Debug, Clone)]
struct ProofStep {
    sibling: [u8; 32],
    sibling_is_right: bool,
}

/// A decoded Merkle proof (spec §6).
pub struct Proof {
    leaf_category: String,
    leaf_version: u32,
    leaf: Vec<Field>,
    leaf_index: u64,
    leaf_count: u64,
    path: Vec<ProofStep>,
}

/// Decode a `FieldJSON` value into a typed `Field`. Returns `None` on any
/// decode failure (malformed hex, missing keys, unknown kind, out-of-range).
fn field_from_json(value: &serde_json::Value) -> Option<Field> {
    let obj = value.as_object()?;
    let kind = obj.get("kind")?.as_str()?;
    match kind {
        "hash" => {
            let hex = obj.get("value")?.as_str()?;
            let arr = from_hex_32(hex)?;
            Some(Field::Hash(arr))
        }
        "u64" => {
            // Decimal string per the JSON serialization (never JS number).
            let s = obj.get("value")?.as_str()?;
            let v: u64 = s.parse().ok()?;
            Some(Field::U64(v))
        }
        "string" => {
            let s = obj.get("value")?.as_str()?;
            Some(Field::String(s.to_string()))
        }
        "bytes" => {
            let hex = obj.get("value")?.as_str()?;
            let bytes = hex_decode(hex)?;
            Some(Field::Bytes(bytes))
        }
        "null" => Some(Field::Null),
        "u8" => {
            let n = obj.get("value")?.as_i64()?;
            if !(0..=255).contains(&n) {
                return None;
            }
            Some(Field::U8(n as u8))
        }
        "bool" => {
            let b = obj.get("value")?.as_bool()?;
            Some(Field::Bool(b))
        }
        _ => None,
    }
}

/// Decode a full `ProofJSON` object into a typed `Proof`. Returns `None` on
/// any structural or value-level decode failure.
pub fn proof_from_json(json: &serde_json::Value) -> Option<Proof> {
    let obj = json.as_object()?;
    let leaf_category = obj.get("leaf_category")?.as_str()?.to_string();
    let leaf_version = obj.get("leaf_version")?.as_i64()? as u32;
    let leaf_arr = obj.get("leaf")?.as_array()?;
    let leaf: Vec<Field> = leaf_arr
        .iter()
        .map(field_from_json)
        .collect::<Option<_>>()?;
    let leaf_index: u64 = obj.get("leaf_index")?.as_str()?.parse().ok()?;
    let leaf_count: u64 = obj.get("leaf_count")?.as_str()?.parse().ok()?;
    let path_arr = obj.get("path")?.as_array()?;
    let path: Vec<ProofStep> = path_arr
        .iter()
        .map(|step| {
            let s = step.as_object()?;
            let sibling = from_hex_32(s.get("sibling")?.as_str()?)?;
            let sibling_is_right = s.get("sibling_is_right")?.as_bool()?;
            Some(ProofStep {
                sibling,
                sibling_is_right,
            })
        })
        .collect::<Option<_>>()?;
    Some(Proof {
        leaf_category,
        leaf_version,
        leaf,
        leaf_index,
        leaf_count,
        path,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// §6.1 Verification algorithm
// ──────────────────────────────────────────────────────────────────────────

/// Verify a decoded Merkle proof against a 32-byte root, implementing spec
/// §6.1 exactly, including category binding (§6.2 epoch/asset binding is
/// applied only when `opts` carries expectations).
///
/// Returns `false` for any verification or decode failure — never panics on
/// a malformed proof.
pub fn verify(proof: &Proof, root: &[u8; 32], expected_category: &str) -> bool {
    // §6.1 step 2: assert proof.leafCategory == expected category
    if proof.leaf_category != expected_category {
        return false;
    }
    // §6.1 step 3: assert proof.leaf_version == 1
    if proof.leaf_version != LEAF_VERSION {
        return false;
    }

    // §6.1 step 1: recompute leaf_hash
    let mut h = hash_leaf_body(proof.leaf_version, &proof.leaf);

    // §6.1 step 4: single-leaf tree → root == H(NODE_DOMAIN ‖ leaf_hash ‖ leaf_hash)
    if proof.leaf_count == 1 {
        if !proof.path.is_empty() {
            return false;
        }
        let node = sha256_node(&h, &h);
        return constant_time_eq(&node, root);
    }

    // §6.1 steps 5–6: walk the path leaf → root
    let mut idx = proof.leaf_index;
    for step in &proof.path {
        if step.sibling_is_right {
            // this node is the LEFT child → idx must be even
            if !idx.is_multiple_of(2) {
                return false;
            }
            h = sha256_node(&h, &step.sibling);
        } else {
            // this node is the RIGHT child → idx must be odd
            if idx % 2 != 1 {
                return false;
            }
            h = sha256_node(&step.sibling, &h);
        }
        idx /= 2;
    }

    // §6.1 step 7: assert h == root
    constant_time_eq(&h, root)
}

/// `H(NODE_DOMAIN ‖ left ‖ right)` — the internal node hash.
fn sha256_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(NODE_DOMAIN);
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

/// Constant-time equality of two 32-byte digests.
fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff: u8 = 0;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level entry used by the CLI `receipts verify` command.
// ──────────────────────────────────────────────────────────────────────────

/// The expected leaf category for a route receipt proof (spec §4.1.4).
pub const ROUTE_RECEIPT_CATEGORY: &str = "capix:receipt:route:v1";

/// Result of a local proof verification.
pub struct VerificationOutcome {
    pub verified: bool,
    pub leaf_category: String,
    pub root_hex: String,
}

/// Verify a proof package against an expected root.
///
/// `proof_json` is the raw JSON fetched from the API (the proof package).
/// `root_hex` is the 64-char lowercase hex Merkle root (e.g. from the
/// on-chain SettlementEpoch PDA, or returned alongside the proof).
/// `expected_category` binds the root to a leaf-category domain.
///
/// This performs NO network access: the cryptographic check is entirely local.
pub fn verify_locally(
    proof_json: &serde_json::Value,
    root_hex: &str,
    expected_category: &str,
) -> Option<VerificationOutcome> {
    let root = from_hex_32(root_hex)?;
    let proof = proof_from_json(proof_json)?;
    let leaf_category = proof.leaf_category.clone();
    let verified = verify(&proof, &root, expected_category);
    Some(VerificationOutcome {
        verified,
        leaf_category,
        root_hex: root_hex.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known vector generated by the TypeScript `@capix/merkle` reference
    /// implementation, to guarantee byte-compatibility across the Rust and TS
    /// verifiers. Two balance leaves (`capix:settlement:account:v1`); the
    /// first input leaf sorts to index 1, with a left sibling.
    const PROOF_JSON_MULTI: &str = r#"{"leaf_category":"capix:settlement:account:v1","leaf_version":1,"leaf":[{"kind":"string","value":"capix:settlement:account:v1"},{"kind":"u64","value":"1"},{"kind":"hash","value":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"kind":"hash","value":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},{"kind":"hash","value":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"kind":"u64","value":"100"},{"kind":"u64","value":"50"},{"kind":"u64","value":"30"},{"kind":"u64","value":"0"},{"kind":"u64","value":"10"},{"kind":"u64","value":"110"},{"kind":"hash","value":"0000000000000000000000000000000000000000000000000000000000000000"},{"kind":"string","value":"v1"}],"leaf_index":"1","leaf_count":"2","path":[{"sibling":"8ba5e36719031cdd5bf5f3e7630fab87af6dca3fcc2a699b15eb6f9349ee2362","sibling_is_right":false}]}"#;

    /// Root for a single-leaf tree from the same leaf hash (TS `buildRoot([lh])`).
    const ROOT_SINGLE_HEX: &str =
        "5a2f84852da8c616d0b4b2e0670ebce58f2886b377df9bb38871a11654980f0c";
    /// Root for the two-leaf tree (TS `buildRoot([lh1, lh2])`).
    const ROOT_MULTI_HEX: &str = "81f336ba4987d8ee76ed3d6c11eb23706edb1e61df49a8f9f6905df72c9c04ac";
    /// Leaf hash from the TS `leafHash(...)` for this leaf.
    const LEAF_HASH_HEX: &str = "d4ca0a94a38fbaeac990a3735a5c979a8115f8c48098907e2626e3caae7ee52a";

    #[test]
    fn recompute_leaf_hash_matches_ts_reference() {
        // Re-derive the hash for the multi-leaf proof and compare to TS.
        let json: serde_json::Value = serde_json::from_str(PROOF_JSON_MULTI).unwrap();
        let proof = proof_from_json(&json).expect("decode");
        // The leaf body includes the category as field 0.
        let h = hash_leaf_body(proof.leaf_version, &proof.leaf);
        assert_eq!(to_hex_string(&h), LEAF_HASH_HEX);
    }

    #[test]
    fn verifies_multi_leaf_proof_against_ts_root() {
        let json: serde_json::Value = serde_json::from_str(PROOF_JSON_MULTI).unwrap();
        let out =
            verify_locally(&json, ROOT_MULTI_HEX, "capix:settlement:account:v1").expect("decode");
        assert!(out.verified, "multi-leaf proof should verify locally");
    }

    #[test]
    fn rejects_wrong_root() {
        let json: serde_json::Value = serde_json::from_str(PROOF_JSON_MULTI).unwrap();
        let out =
            verify_locally(&json, ROOT_SINGLE_HEX, "capix:settlement:account:v1").expect("decode");
        assert!(
            !out.verified,
            "multi-leaf proof must NOT verify against the single-leaf root"
        );
    }

    #[test]
    fn rejects_wrong_category() {
        let json: serde_json::Value = serde_json::from_str(PROOF_JSON_MULTI).unwrap();
        let out = verify_locally(&json, ROOT_MULTI_HEX, "capix:receipt:route:v1").expect("decode");
        assert!(!out.verified, "cross-category proof must be rejected");
    }

    #[test]
    fn rejects_malformed_root() {
        let json: serde_json::Value = serde_json::from_str(PROOF_JSON_MULTI).unwrap();
        assert!(verify_locally(&json, "tooshort", "capix:settlement:account:v1").is_none());
    }

    fn to_hex_string(bytes: &[u8; 32]) -> String {
        let mut s = String::with_capacity(64);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }
}
