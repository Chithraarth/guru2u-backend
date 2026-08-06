import type { Request, Response, NextFunction } from "express";
import { firebaseAuth } from "../lib/firebase-admin";
import { db, usersTable } from "@workspace/db";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    req.userId = decoded.uid;
    // JIT provision a local user row (idempotent); capture email on first sight
    // since we have no separate user-lookup API to backfill it later.
    await db
      .insert(usersTable)
      .values({ id: decoded.uid, email: decoded.email ?? null })
      .onConflictDoNothing();
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
}
