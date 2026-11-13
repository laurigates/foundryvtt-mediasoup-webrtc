//! Caps on concurrent connections, checked as soon as a TCP connection is
//! accepted, before any TLS or WebSocket handshake work (#118).

use crate::config::LimitsConfig;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

/// Which cap refused a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitExceeded {
    /// `MEDIASOUP_MAX_CONNECTIONS`.
    Total(usize),
    /// `MEDIASOUP_MAX_CONNECTIONS_PER_IP`.
    PerIp(usize),
}

impl std::fmt::Display for LimitExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Total(max) => write!(f, "server connection limit ({max}) reached"),
            Self::PerIp(max) => write!(f, "per-IP connection limit ({max}) reached"),
        }
    }
}

#[derive(Debug, Default)]
struct Counts {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
}

/// Counts open connections, globally and per source IP. A limit of 0 means
/// unlimited.
#[derive(Debug)]
pub struct ConnectionLimiter {
    max_total: usize,
    max_per_ip: usize,
    counts: Mutex<Counts>,
}

impl ConnectionLimiter {
    pub fn new(limits: &LimitsConfig) -> Arc<Self> {
        Arc::new(Self {
            max_total: limits.max_connections,
            max_per_ip: limits.max_connections_per_ip,
            counts: Mutex::new(Counts::default()),
        })
    }

    /// Reserve a slot for a connection from `ip`. The slot is released when
    /// the returned guard is dropped.
    pub fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Result<ConnectionGuard, LimitExceeded> {
        // IPv4-mapped IPv6 (`::ffff:a.b.c.d`, from a dual-stack listener)
        // counts as the IPv4 address.
        let ip = ip.to_canonical();
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if self.max_total != 0 && counts.total >= self.max_total {
            return Err(LimitExceeded::Total(self.max_total));
        }
        let from_ip = counts.per_ip.get(&ip).copied().unwrap_or(0);
        if self.max_per_ip != 0 && from_ip >= self.max_per_ip {
            return Err(LimitExceeded::PerIp(self.max_per_ip));
        }
        counts.total += 1;
        counts.per_ip.insert(ip, from_ip + 1);
        Ok(ConnectionGuard {
            limiter: self.clone(),
            ip,
        })
    }

    /// Open connections in total.
    pub fn total(&self) -> usize {
        self.counts.lock().unwrap_or_else(|e| e.into_inner()).total
    }

    fn release(&self, ip: IpAddr) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        counts.total = counts.total.saturating_sub(1);
        if let Some(n) = counts.per_ip.get_mut(&ip) {
            *n -= 1;
            if *n == 0 {
                counts.per_ip.remove(&ip);
            }
        }
    }
}

/// One reserved connection slot; released on drop.
#[derive(Debug)]
pub struct ConnectionGuard {
    limiter: Arc<ConnectionLimiter>,
    ip: IpAddr,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.limiter.release(self.ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter(max_connections: usize, max_connections_per_ip: usize) -> Arc<ConnectionLimiter> {
        ConnectionLimiter::new(&LimitsConfig {
            max_connections,
            max_connections_per_ip,
        })
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn per_ip_cap_is_per_address_and_released_on_drop() {
        let limiter = limiter(0, 2);
        let a1 = limiter.try_acquire(ip("192.0.2.1")).expect("first");
        let _a2 = limiter.try_acquire(ip("192.0.2.1")).expect("second");
        assert_eq!(
            limiter.try_acquire(ip("192.0.2.1")).unwrap_err(),
            LimitExceeded::PerIp(2)
        );
        // The mapped form of the same address shares its count.
        assert!(limiter.try_acquire(ip("::ffff:192.0.2.1")).is_err());
        // Another address is unaffected.
        let _b = limiter.try_acquire(ip("192.0.2.2")).expect("other ip");
        assert_eq!(limiter.total(), 3);

        drop(a1);
        assert_eq!(limiter.total(), 2);
        let _a3 = limiter.try_acquire(ip("192.0.2.1")).expect("slot released");
    }

    #[test]
    fn total_cap_applies_across_addresses() {
        let limiter = limiter(2, 0);
        let _a = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        let b = limiter.try_acquire(ip("2001:db8::1")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("192.0.2.3")).unwrap_err(),
            LimitExceeded::Total(2)
        );
        drop(b);
        assert!(limiter.try_acquire(ip("192.0.2.3")).is_ok());
    }

    #[test]
    fn zero_means_unlimited() {
        let limiter = limiter(0, 0);
        let guards: Vec<_> = (0..1000)
            .map(|_| limiter.try_acquire(ip("192.0.2.1")).unwrap())
            .collect();
        assert_eq!(limiter.total(), 1000);
        drop(guards);
        assert_eq!(limiter.total(), 0);
        assert!(limiter.counts.lock().unwrap().per_ip.is_empty());
    }
}
