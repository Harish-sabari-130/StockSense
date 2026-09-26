import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  ForgotPasswordBody,
  LoginBody,
  ResetPasswordBody,
  SignupBody,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { activityLogs, passwordResetOtps, users } from "@workspace/db/schema";
import {
  hashPassword,
  requireAuth,
  safeUser,
  signToken,
  verifyPassword,
  type AuthenticatedRequest,
} from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/signup", async (req, res) => {
  try {
    const input = SignupBody.parse(req.body);
    const email = input.email.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return res.status(400).json({ error: "An account with that email already exists" });
    const [user] = await db
      .insert(users)
      .values({ name: input.name.trim(), email, passwordHash: await hashPassword(input.password) })
      .returning();
    if (!user) return res.status(400).json({ error: "Unable to create account" });
    await db.insert(activityLogs).values({
      action: "Registered account",
      entity: "User",
      reference: user.email,
      userId: user.id,
    });
    return res.status(201).json({ token: signToken(user), user: safeUser(user) });
  } catch {
    return res.status(400).json({ error: "Please provide a valid name, email, and password" });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const input = LoginBody.parse(req.body);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()))
      .limit(1);
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      return res.status(401).json({ error: "Email or password is incorrect" });
    }
    await db.insert(activityLogs).values({
      action: "Signed in",
      entity: "User",
      reference: user.email,
      userId: user.id,
    });
    return res.json({ token: signToken(user), user: safeUser(user) });
  } catch {
    return res.status(401).json({ error: "Email or password is incorrect" });
  }
});

router.get("/auth/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (!user) return res.status(401).json({ error: "Session expired" });
  return res.json(safeUser(user));
});

router.post("/auth/forgot-password", async (req, res) => {
  try {
    const input = ForgotPasswordBody.parse(req.body);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()))
      .limit(1);
    if (!user) return res.status(404).json({ error: "No account found for that email" });
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await db.insert(passwordResetOtps).values({
      userId: user.id,
      otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return res.json({ message: "Development OTP generated. Use it to continue.", otp });
  } catch {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
});

router.post("/auth/reset-password", async (req, res) => {
  try {
    const input = ResetPasswordBody.parse(req.body);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()))
      .limit(1);
    if (!user) return res.status(400).json({ error: "Invalid reset request" });
    const [reset] = await db
      .select()
      .from(passwordResetOtps)
      .where(
        and(
          eq(passwordResetOtps.userId, user.id),
          eq(passwordResetOtps.otp, input.otp),
          isNull(passwordResetOtps.usedAt),
        ),
      )
      .orderBy(desc(passwordResetOtps.id))
      .limit(1);
    if (!reset || reset.expiresAt < new Date()) return res.status(400).json({ error: "That OTP is invalid or expired" });
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(input.password), updatedAt: new Date() }).where(eq(users.id, user.id));
      await tx.update(passwordResetOtps).set({ usedAt: new Date() }).where(eq(passwordResetOtps.id, reset.id));
    });
    return res.json({ message: "Password updated. You can sign in now." });
  } catch {
    return res.status(400).json({ error: "Invalid reset request" });
  }
});

export default router;