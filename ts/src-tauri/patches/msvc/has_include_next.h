/*
 * Forced into every C file of a Windows build (CFLAGS /FI, set in the
 * Windows steps of .github/workflows/tauri-release.yml and rust-check.yml).
 *
 * espeak-ng, which espeak-rs-sys 0.2.0 builds for Piper's phonemes, tests
 * `#if __has_include_next(<unistd.h>)` unguarded in its compat headers. MSVC
 * 14.52 made an undefined function-like macro in #if an error (C7780), and it
 * has no #include_next, so the answer is no.
 *
 * Delete this and the two workflow steps once espeak-rs-sys guards the test.
 */
#ifndef __has_include_next
#define __has_include_next(header) 0
#endif
