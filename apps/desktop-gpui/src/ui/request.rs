//! Stale-request guards for async loads.
//!
//! Each load increments a token, captures the new value, and only applies its
//! result when the token is still current. Centralising the arithmetic keeps
//! the wrapping and comparison rules identical across the list, detail and
//! graph tasks.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RequestToken(u64);

impl RequestToken {
    /// Increment and return the new token for an in-flight request.
    pub fn advance(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(1);
        self.0
    }

    /// True when `token` is still the most recently issued value.
    pub fn is_current(&self, token: u64) -> bool {
        self.0 == token
    }

    pub fn current(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_invalidate_previous_requests_and_wrap() {
        let mut token = RequestToken::default();
        let first = token.advance();
        assert!(token.is_current(first));
        let second = token.advance();
        assert!(!token.is_current(first));
        assert!(token.is_current(second));

        token = RequestToken(u64::MAX);
        let wrapped = token.advance();
        assert_eq!(wrapped, 0);
        assert!(token.is_current(wrapped));
    }
}
