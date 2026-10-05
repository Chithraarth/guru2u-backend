import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";

// Apple Root CA - G3 (DER, base64), from
// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// SHA-256 fingerprint 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79.
// Inlined rather than read from disk because the runtime image only ships dist/.
const APPLE_ROOT_CA_G3 = Buffer.from(
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYD" +
  "VQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN" +
  "MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFw" +
  "cGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49" +
  "AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA" +
  "/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr" +
  "MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZL" +
  "uN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM" +
  "6BgD56KyKA==",
  "base64",
);

export function appleBundleId(): string {
  return process.env.APPLE_BUNDLE_ID || "com.guru2u.app";
}

// The numeric App Store Connect app ID — required by Apple to verify
// production-environment data.
function appleAppId(): number {
  return Number(process.env.APPLE_APP_ID || "6818843003");
}

let verifiers: SignedDataVerifier[] | null = null;

// Production first, then Sandbox: TestFlight and App Review purchases are
// signed for the Sandbox environment, live App Store purchases for Production.
function getVerifiers(): SignedDataVerifier[] {
  if (!verifiers) {
    verifiers = [
      new SignedDataVerifier([APPLE_ROOT_CA_G3], true, Environment.PRODUCTION, appleBundleId(), appleAppId()),
      new SignedDataVerifier([APPLE_ROOT_CA_G3], true, Environment.SANDBOX, appleBundleId()),
    ];
  }
  return verifiers;
}

async function tryEach<T>(fn: (v: SignedDataVerifier) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const verifier of getVerifiers()) {
    try {
      return await fn(verifier);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Verifies a StoreKit 2 signed transaction (JWS) against Apple's certificate chain. */
export function verifySignedTransaction(jws: string): Promise<JWSTransactionDecodedPayload> {
  return tryEach((v) => v.verifyAndDecodeTransaction(jws));
}

/** Verifies an App Store Server Notification V2 payload. */
export function verifySignedNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload> {
  return tryEach((v) => v.verifyAndDecodeNotification(signedPayload));
}
