import { Router, type IRouter } from "express";
import healthRouter from "./health";
import readingsRouter from "./readings";
import billingRouter, { webhookRouter as billingWebhookRouter } from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(readingsRouter);
router.use(billingRouter);
router.use(billingWebhookRouter);

export default router;
