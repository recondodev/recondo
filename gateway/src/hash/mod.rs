use std::fmt::Write;

use sha2::{Digest, Sha256};

/// Compute the SHA-256 hash of the given bytes and return it as a lowercase hex string.
pub fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let result = hasher.finalize();
    let mut hex = String::with_capacity(result.len() * 2);
    for &b in &result {
        write!(hex, "{:02x}", b).unwrap();
    }
    hex
}
