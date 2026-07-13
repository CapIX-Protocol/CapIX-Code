//! CPX display formatting — integer-only, no floating point.
//!
//! All monetary amounts are represented internally as unsigned 64-bit minor
//! units (the smallest indivisible unit of the asset). Display formatting
//! inserts the decimal point via integer division and string concatenation
//! so that no rounding error can ever be introduced.
//!
//! Invariants:
//!  - Never uses `f64` / `f32` for money.
//!  - Never logs secrets.
//!  - CPX billing surfaces the "burned at settlement — providers never paid
//!    in CPX" notice wherever a balance is shown.

/// Format a minor-unit amount as a human-readable decimal string.
///
/// `amount_minor` is the raw integer amount (e.g. lamports for CPX with
/// `decimals = 9`). `decimals` is the asset's decimal precision. Returns a
/// string like `"1.234567890"` or `"0"` when the amount is zero with zero
/// decimals.
///
/// Examples:
///   `format_cpx_display(1_500_000_000, 9)` → `"1.500000000"`
///   `format_cpx_display(0, 9)`             → `"0.000000000"`
///   `format_cpx_display(5, 0)`              → `"5"`
pub fn format_cpx_display(amount_minor: u64, decimals: u8) -> String {
    if decimals == 0 {
        return amount_minor.to_string();
    }
    let divisor: u64 = 10u64.checked_pow(decimals as u32).unwrap_or(u64::MAX);
    let whole = amount_minor / divisor;
    let frac = amount_minor % divisor;
    if frac == 0 {
        // Still honour the decimal places for consistency, padded with zeros.
        let zeros = "0".repeat(decimals as usize);
        return format!("{whole}.{zeros}");
    }
    let mut frac_str = frac.to_string();
    while frac_str.len() < decimals as usize {
        frac_str.insert(0, '0');
    }
    format!("{whole}.{frac_str}")
}

/// Format a CPX amount with its USD reference price, integer-only.
///
/// `cpx_minor`     — CPX amount in minor units (lamports).
/// `cpx_decimals`  — CPX decimal precision (e.g. 9).
/// `price_usd_minor` — USD price per whole CPX, in minor units of USD
///                    (e.g. cents → `price_usd_minor` at `usd_decimals = 2`,
///                    so $3.50 = 350). `usd_decimals` defaults to 2.
///
/// The reference is computed as `cpx_whole * usd_price` using integer math,
/// returning a string like `"1.500000000 CPX (≈ $5.25 USD)"`. A zero or
/// missing price yields `"(USD reference unavailable)"`.
pub fn format_usd_reference(
    cpx_minor: u64,
    cpx_decimals: u8,
    price_usd_minor: u64,
) -> String {
    let cpx_str = format_cpx_display(cpx_minor, cpx_decimals);
    if price_usd_minor == 0 {
        return format!("{cpx_str} CPX (≈ USD reference unavailable)");
    }
    // Integer-only: USD (minor) = price_per_whole_cpx_minor × cpx_minor / 10^decimals.
    // A u128 intermediate avoids overflow while keeping full fractional-CPX
    // precision before the final division back to u64 USD minor units.
    let divisor = 10u128.pow(cpx_decimals as u32);
    let usd_total_minor: u128 =
        (cpx_minor as u128).saturating_mul(price_usd_minor as u128) / divisor;
    let usd_str = format_cpx_display(usd_total_minor as u64, 2);
    format!("{cpx_str} CPX (≈ ${usd_str} USD)")
}

/// The standard notice shown alongside any CPX balance display.
pub const CPX_BURN_NOTICE: &str =
    "burned at settlement — providers never paid in CPX";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_nine_decimals() {
        assert_eq!(format_cpx_display(1_500_000_000, 9), "1.500000000");
        assert_eq!(format_cpx_display(0, 9), "0.000000000");
        assert_eq!(format_cpx_display(1, 9), "0.000000001");
    }

    #[test]
    fn formats_zero_decimals() {
        assert_eq!(format_cpx_display(42, 0), "42");
    }

    #[test]
    fn usd_reference_zero_price() {
        let s = format_usd_reference(1_500_000_000, 9, 0);
        assert!(s.contains("USD reference unavailable"));
    }

    #[test]
    fn usd_reference_nonzero() {
        // 1.5 CPX @ $3.50 = $5.25
        let s = format_usd_reference(1_500_000_000, 9, 350);
        assert!(s.contains("5.25"));
        assert!(s.contains("1.500000000 CPX"));
    }

    #[test]
    fn fraction_pads_correctly() {
        // 0.1 CPX = 100_000_000 lamports at 9 decimals → "0.100000000"
        assert_eq!(format_cpx_display(100_000_000, 9), "0.100000000");
    }
}
