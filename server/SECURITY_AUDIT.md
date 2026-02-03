# Security Audit Report

## Updated Dependencies (2025-09-08)

### Major Version Updates
- **MediaSoup**: 0.18 → 0.20.0
- **tokio-tungstenite**: 0.21 → 0.27.0  
- **warp**: 0.3 → 0.4.2

### Resolved Issues
- **slab**: Avoided yanked version 0.4.10, using 0.4.11
- **API Compatibility**: Fixed breaking changes in MediaSoup 0.20:
  - Updated `ListenInfo` struct to include `expose_internal_ip` field
  - Fixed `get_rtp_capabilities()` return type (now returns value instead of reference)
  - Updated WebSocket `Message::Text` to accept `Utf8Bytes` instead of `String`

### Remaining Advisories (Transitive Dependencies)

The following security advisories remain due to transitive dependencies through `mediasoup-sys`:

#### RUSTSEC-2024-0436: paste is unmaintained
- **Crate**: paste v0.1.18
- **Status**: Unmaintained (compile-time only, low risk)
- **Path**: paste → bitpattern → h264-profile-level-id → mediasoup
- **Impact**: Used only for compile-time code generation

#### RUSTSEC-2024-0375: atty is unmaintained  
- **Crate**: atty v0.2.14
- **Status**: Unmaintained (low runtime risk)
- **Path**: atty → planus-translation → mediasoup-sys → mediasoup
- **Impact**: Used for terminal detection

#### RUSTSEC-2021-0145: atty potential unaligned read
- **Crate**: atty v0.2.14
- **Status**: Unsound (theoretical issue)
- **Path**: Same as above
- **Impact**: Potential unaligned memory access (rare occurrence)

#### RUSTSEC-2024-0384: instant is unmaintained
- **Crate**: instant v0.1.13  
- **Status**: Unmaintained (timing utilities)
- **Path**: instant → parking_lot/fastrand → mediasoup
- **Impact**: Used for timing in concurrency primitives

## Audit Commands

To run security audit accepting these known issues:

```bash
cargo audit --ignore RUSTSEC-2024-0436 --ignore RUSTSEC-2024-0375 --ignore RUSTSEC-2021-0145 --ignore RUSTSEC-2024-0384
```

To see all current advisories:

```bash
cargo audit
```

## Risk Assessment

All remaining advisories are:
1. **Low Risk**: Compile-time only or utility functions
2. **Transitive**: Cannot be directly resolved without mediasoup-sys updates  
3. **Acceptable**: No known exploits or high-severity vulnerabilities

## Recommendations

1. **Monitor mediasoup updates**: Check for newer versions that may resolve transitive dependencies
2. **Regular audits**: Run `cargo audit` monthly to catch new issues
3. **Consider alternatives**: If security requirements are strict, evaluate alternative WebRTC libraries

## Last Updated
2025-09-08 - Dependency updates and API compatibility fixes completed