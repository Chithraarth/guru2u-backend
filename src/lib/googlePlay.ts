import { google } from "googleapis";
import type { androidpublisher_v3 } from "googleapis";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function buildAuth() {
  return new google.auth.JWT({
    email: requireEnv("GOOGLE_PLAY_CLIENT_EMAIL"),
    key: requireEnv("GOOGLE_PLAY_PRIVATE_KEY").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
}

let publisher: androidpublisher_v3.Androidpublisher | null = null;

function getPublisher(): androidpublisher_v3.Androidpublisher {
  if (!publisher) {
    publisher = google.androidpublisher({ version: "v3", auth: buildAuth() });
  }
  return publisher;
}

export function androidPackageName(): string {
  return requireEnv("ANDROID_PACKAGE_NAME");
}

export type ProductPurchaseStatus = {
  // purchaseState 0 in the Play API; true means the purchase actually went
  // through (not canceled/pending).
  isPurchased: boolean;
  alreadyConsumed: boolean;
  obfuscatedExternalAccountId: string | null;
  acknowledgementState: "acknowledged" | "pending" | "unspecified";
};

// Verifies a one-time (consumable) product purchase against the Play
// Developer API — the server-side source of truth. Never trust a client's
// claim that it paid; the purchase token alone proves nothing until Google
// confirms it.
export async function verifyProductPurchase(
  productId: string,
  purchaseToken: string,
): Promise<ProductPurchaseStatus> {
  const publisher = getPublisher();
  const packageName = androidPackageName();

  const { data } = await publisher.purchases.products.get({
    packageName,
    productId,
    token: purchaseToken,
  });

  const ackState =
    data.acknowledgementState === 1
      ? "acknowledged"
      : data.acknowledgementState === 0
        ? "pending"
        : "unspecified";

  return {
    isPurchased: data.purchaseState === 0,
    alreadyConsumed: data.consumptionState === 1,
    obfuscatedExternalAccountId: data.obfuscatedExternalAccountId ?? null,
    acknowledgementState: ackState,
  };
}

// Play auto-refunds a purchase if it isn't acknowledged within 3 days —
// must be called once after verifying a brand-new purchase.
export async function acknowledgeProductPurchase(
  productId: string,
  purchaseToken: string,
): Promise<void> {
  const publisher = getPublisher();
  const packageName = androidPackageName();

  await publisher.purchases.products.acknowledge({
    packageName,
    productId,
    token: purchaseToken,
    requestBody: {},
  });
}

// Marks the purchase as consumed server-side, so the user can immediately
// buy another pack — we do this ourselves rather than relying solely on the
// client calling finishTransaction, in case the app is killed before it
// gets a chance to.
export async function consumeProductPurchase(
  productId: string,
  purchaseToken: string,
): Promise<void> {
  const publisher = getPublisher();
  const packageName = androidPackageName();

  await publisher.purchases.products.consume({
    packageName,
    productId,
    token: purchaseToken,
  });
}
