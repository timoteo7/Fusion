---
category: best-practices
module: "host tooling"
date: 2026-10-04
problem_type: tooling_setup
component: android-static-analysis
severity: low
applies_when:
  - "Standing up an authorized Android APK reverse-engineering environment on a Linux host"
  - "You need which servers an app contacts, its endpoints, or its auth scheme without a device"
  - "A decompiler runs but the interesting classes decompile to empty files"
  - "Deciding whether an offline static read is enough or you need a real capture"
tags:
  - android
  - apk
  - reverse-engineering
  - jadx
  - apktool
  - mitmproxy
  - security
---

# Android APK static analysis tooling setup (authorized targets only)

<!--
FNXC:ApkStaticAnalysisTooling 2026-10-04-01:26:
Android reverse engineering is only useful for targets the operator is authorized to analyze. Every command here
runs against a sample whose license permits redistribution. Never point this pipeline at an app you have no
authorization to inspect: extracting endpoints and credentials from someone else's APK is not the use case this
document describes.

This records what was ACTUALLY executed on one Linux host, with observed versions and checksums. The interesting
operational finding is the "0-byte decompile" trap in Step 3 - jadx exits 0 and prints "done" while every class that
matters comes out empty, so a decompiler that "succeeded" is not evidence that it decompiled anything.
-->

## Result

A private, unprivileged tool prefix plus the standard official tools make it possible to answer, from a single APK
with no device and no emulator: which host the app talks to, which endpoints it calls, with which HTTP method, what
it sends as authentication, and what it stores locally.

| Tool | Version observed | Install path | SHA-256 observed |
|---|---|---|---|
| Eclipse Temurin JDK | `21.0.12.1+1` (LTS) | `~/.local/opt/apk-re/jdk/jdk-21.0.12.1+1` | — (expanded from the Adoptium tarball) |
| jadx | `1.5.6` | `~/.local/opt/apk-re/lib/jadx-1.5.6-all.jar` | `fe3e12c45acf75f92369685fd02d1d7a7323385dc725680a9b98a0dac0ea554b` |
| apktool | `3.0.3` | `~/.local/opt/apk-re/apktool.jar` | `dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423` |
| mitmproxy | `12.2.3` (Python 3.14.7, OpenSSL 4.0.1) | `~/.local/opt/apk-re/mitmproxy-lib` | — (installed from the mitmproxy.org Linux distribution) |

All of it lives under a single private prefix, needs no `sudo`, touches no other host, and is removed by deleting
that one directory. Nothing in the prefix is version-controlled.

Official sources only:

- jadx — <https://github.com/skylot/jadx> · docs <https://jadx.io/>
- apktool — <https://github.com/iBotPeaches/Apktool> · docs <https://apktool.org/>
- mitmproxy — <https://github.com/mitmproxy/mitmproxy> · docs <https://docs.mitmproxy.org/stable/> · downloads <https://mitmproxy.org/downloads/>
- Eclipse Temurin JDK — <https://github.com/adoptium/temurin21-binaries> · releases <https://adoptium.net/temurin/releases/>

## 1. Install

Put each tool in its own private prefix so one `rm -rf` reverses the whole thing.

```bash
# JDK 21 (the jadx prerequisite). Never mutate or shadow the system JVM.
export PREFIX="$HOME/.local/opt/apk-re"
mkdir -p "$PREFIX/jdk"
tar -xzf OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1+1.tar.gz -C "$PREFIX/jdk"

# jadx: the official CLI jar from the GitHub release.
curl -fL -o "$PREFIX/lib/jadx-1.5.6-all.jar" \
  https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6-all.jar

# apktool: the official jar, run with `java -jar`.
curl -fL -o "$PREFIX/apktool.jar" \
  https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar

# mitmproxy: install into the prefix. Its GitHub releases carry no downloadable
# assets - the standalone Linux build ships from mitmproxy.org, so do NOT
# construct a releases/latest/download/mitmproxy-*.whl URL.
curl -fL -o "$PREFIX/mitmproxy.tar.gz" \
  https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz
tar -xzf "$PREFIX/mitmproxy.tar.gz" -C "$PREFIX" --strip-components=1
```

Thin wrappers that pin `JAVA_HOME` per tool, so the JDK 8 on `PATH` is never disturbed:

```bash
# $PREFIX/bin/jadx
export JAVA_HOME="$HOME/.local/opt/apk-re/jdk/jdk-21.0.12.1+1"
exec "$JAVA_HOME/bin/java" -cp "$HOME/.local/opt/apk-re/lib/jadx-1.5.6-all.jar" jadx.cli.JadxCLI "$@"

# $PREFIX/bin/apktool
export JAVA_HOME="$HOME/.local/opt/apk-re/jdk/jdk-21.0.12.1+1"
exec "$JAVA_HOME/bin/java" -jar "$HOME/.local/opt/apk-re/apktool.jar" "$@"

# $PREFIX/bin/mitmdump and mitmweb
export PYTHONPATH="$HOME/.local/opt/apk-re/mitmproxy-lib"
exec "$HOME/.local/opt/apk-re/mitmproxy-lib/bin/mitmdump" "$@"
```

Verify each one actually runs, rather than assuming the file landing on disk means it works:

```bash
export PATH="$HOME/.local/opt/apk-re/bin:$PATH"
java -version    # openjdk version "21.0.12.1"
javac -version   # javac 21.0.12.1
jadx --version   # 1.5.6
apktool --version  # 3.0.3
mitmdump --version  # Mitmproxy: 12.2.3
```

## 2. Proxy: start it, then be honest about what you proved

The `mitmproxy` console UI needs a TTY and exits with `mitmproxy's console interface requires a tty` when run from
a script or an agent session. The headless entry points are `mitmdump` and `mitmweb`. Prove the listening state
under a bounded timeout and then stop it:

```bash
mitmweb --listen-host 127.0.0.1 --listen-port 18083 \
        --web-host 127.0.0.1 --web-port 18084 &
sleep 10
ss -ltn | grep -E '18083|18084'   # both sockets must appear
kill %1
```

Observed on this host:

```
LISTEN 0 100 127.0.0.1:18083 0.0.0.0:*   # proxy port
LISTEN 0 128 127.0.0.1:18084 0.0.0.0:*   # web UI
HTTP(S) proxy listening at 127.0.0.1:18083.
Web server listening at http://127.0.0.1:18084/
```

**This proves the proxy starts and binds. It does not prove a capture.** A real dynamic capture additionally needs a
device or emulator on the same network, the device trusting mitmproxy's CA
(`~/.mitmproxy/mitmproxy-ca-cert.pem`), and a target that honors that CA. None of those were performed here, so no
traffic was captured and none is claimed.

## 3. Decompile — and check that it actually decompiled something

```bash
jadx -d out --show-bad-code --comments-level debug sample.apk
```

**The trap.** A default `jadx -d out sample.apk` on this APK exited `0`, printed `INFO - done` after
`progress: 2291 of 2291`, and still wrote **0-byte files** for every class that matters:

```
DoLogin.java        0
DoTransfer.java     0
PostLogin.java      0
ChangePassword.java 0
WrongLogin.java     0
ViewStatement.java  0
```

`--show-bad-code` emitted the method bodies anyway, turning those same six files into 9.0 KB / 17.3 KB / 4.7 KB /
9.7 KB / 1.5 KB / 2.6 KB. A non-zero exit is not the signal — **check for non-empty sources.** A decompiler that
"ran successfully" is not evidence that it recovered any code.

## 4. Extract the inventory

```bash
# Endpoint paths, with the HTTP verb from the same constructor call.
grep -rnE 'new Http(Post|Get)\(' out/sources/<pkg>/

# Auth FIELD NAMES only — never values.
grep -rhoE 'BasicNameValuePair\("[a-z_]+"' out/sources/<pkg>/ | sort -u

# Local datastore: SQLite tables and preference keys.
grep -rhoE 'CREATE TABLE [a-z_]+' out/sources/<pkg>/ | sort -u
grep -rhoE 'getString\("[a-zA-Z_]+"' out/sources/<pkg>/ | sort -u

# Manifest permissions and flags.
apktool d -f -o apktool-out sample.apk
grep -oE 'android\.permission\.[A-Z_]+' apktool-out/AndroidManifest.xml | sort -u
```

Script the assertions rather than eyeballing the output — an empty inventory must fail the check, not quietly pass:

```bash
A="out/sources/com/android/insecurebankv2"
fail=0
n=$(grep -rhoE 'new Http(Post|Get)\([^;]*?/([a-z]+)"' "$A" --include=*.java \
      | sed -E 's/.*\///; s/"$//' | sort -u | wc -l)
[ "$n" -gt 0 ] || { echo "FAIL: no endpoint paths"; fail=1; }
n=$(grep -rhoE 'BasicNameValuePair\("[a-z_]+"' "$A" --include=*.java | sort -u | wc -l)
[ "$n" -gt 0 ] || { echo "FAIL: no auth fields"; fail=1; }
n=$(find "$A" -name '*.java' -size +0 | wc -l)
[ "$n" -gt 0 ] || { echo "FAIL: decompile produced empty sources"; fail=1; }
exit $fail
```

Verify the check has teeth by pointing it at an empty directory and confirming it exits non-zero. A green assertion
that never went red proves nothing.

## Worked example: a real result

**Sample:** [dineshshetty/Android-InsecureBankv2](https://github.com/dineshshetty/Android-InsecureBankv2) — the
OWASP-supported successor to DIVA, shipped as an intentionally vulnerable training app. **License: MIT.**
**SHA-256:** `b18af2a0e44d7634bbcdf93664d9c78a2695e050393fcfbb5e8b91f902d194a4` (3,462,429 bytes).
Package `com.android.insecurebankv2`.

### Backend

The base URL is **not hardcoded**. Every call builds `protocol + serverip + ":" + serverport`, where
`protocol = "http://"` and `serverip` / `serverport` are read from `SharedPreferences` and configured by the operator
on the device's first run (`FilePrefActivity`, keys `serverip` / `serverport`). Consequences worth knowing:

- There is no server to "discover" from the APK. You configure one, or read it off a device you own.
- The scheme is **cleartext HTTP** with no `usesCleartextTraffic` override and no network-security config, so traffic
  is interceptable — which is precisely what makes this app useful for training.
- The **backend database is UNKNOWN.** The APK names no server-side database. Only the on-device SQLite table
  `names` is visible from the client, and it tracks login usernames — it is not the server's store. Do not name a
  server backend on the strength of this app.

### Endpoints

All five are `POST` via `org.apache.http.client.methods.HttpPost` (`DefaultHttpClient`, no auth header).

| Endpoint | Class | Request field names |
|---|---|---|
| `/login` | `DoLogin` | `username`, `password` |
| `/devlogin` | `DoLogin` | `username`, `password` |
| `/dotransfer` | `DoTransfer` | `username`, `password`, `from_acc`, `to_acc`, `amount` |
| `/getaccounts` | `DoTransfer` | `username`, `password` |
| `/changepassword` | `ChangePassword` | `username`, `newpassword` |

`/devlogin` is used when the submitted username is `devadmin` — an intentional backdoor in this training app.

### Authentication

Form-encoded credentials in the POST body — no bearer token, no API key, no custom header. Field **names** are
`username` and `password` (`newpassword` on password change). Values are deliberately not recorded here.

Session state is stored client-side and re-sent on every subsequent call:

- `SharedPreferences` file `mySharedPreferences`, keys `EncryptedUsername` (Base64 of the username) and
  `superSecurePassword` (the password after `CryptoClass` AES encryption).
- `CryptoClass` uses `AES/CBC/PKCS5Padding` with a hardcoded key and an all-zero 16-byte IV — a deliberately broken
  construction, and the reason this app is a teaching artifact rather than a model to copy.

**Reading a raw URL grep.** Grepping every string in the APK for `https?://` returns ~40 hits that are almost all
noise from bundled Google Play Services libraries (`schema.org` verbs, `googleapis.com/auth/*` scopes, social login
hosts). None are bank endpoints. Scope extraction to the app's own package directory rather than the whole decompile
tree, or the real endpoints drown in library constants.

### Local datastore

- SQLite via `TrackUserContentProvider`: `CREATE TABLE names (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
  authority `content://com.android.insecurebankv2.TrackUserContentProvider/trackerusers`. Records usernames at each
  successful login.
- `SharedPreferences` `mySharedPreferences`: `serverip`, `serverport`, `EncryptedUsername`, `superSecurePassword`.

### Manifest permissions

`INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_COARSE_LOCATION`, `GET_ACCOUNTS`, `USE_CREDENTIALS`, `READ_CONTACTS`,
`READ_PHONE_STATE`, `READ_PROFILE`, `READ_CALL_LOG`, `SEND_SMS`, `READ_EXTERNAL_STORAGE` (maxSdk 18),
`WRITE_EXTERNAL_STORAGE`.

## Limits

- **Static only.** No traffic was captured; the proxy was proven to start, nothing more.
- **No emulator, no KVM, no Frida.** No dynamic instrumentation was attempted. `adb` was verified present and left
  alone — no device is attached to this host.
- **The findings are sample-specific.** Endpoint paths, field names and the datastore above describe
  InsecureBankv2. For a different APK, rerun the Step 4 extraction; the *method* generalizes, the *results* do not.
- **No server backend is identified**, because this sample does not name one and static analysis of the client
  cannot prove it.
- **`--show-bad-code` output is best-effort.** Where jadx had to emit imperfect code, read it against `apktool`
  resources and the smali before trusting a specific line.