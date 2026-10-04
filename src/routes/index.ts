import { Router, type IRouter } from "express";
import healthRouter from "./health";
import readingsRouter from "./readings";
import billingRouter, { webhookRouter as billingWebhookRouter } from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(readingsRouter);
// Webhooks first: billingRouter applies requireAuth to every /billing path,
// which would reject Google's and Apple's unauthenticated callbacks.
router.use(billingWebhookRouter);
router.use(billingRouter);

export default router;
