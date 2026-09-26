import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import type { User } from "@workspace/db";

const secret = process.env.SESSION_SECRET ?? "stocksense-local-dev-secret";

export type AuthenticatedRequest = Request & { user?: User };

export function signToken(user: User) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, secret, {
    expiresIn: "7d",
  });
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const payload = jwt.verify(header.slice(7), secret) as { sub?: string };
    if (!payload.sub) return res.status(401).json({ error: "Invalid session" });
    req.user = { id: Number(payload.sub) } as User;
    return next();
  } catch {
    return res.status(401).json({ error: "Session expired" });
  }
}

export function safeUser(user: User) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}