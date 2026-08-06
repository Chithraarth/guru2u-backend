import { Router, type IRouter } from "express";
import healthRouter from "./health";
import readingsRouter from "./readings";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(readingsRouter);
router.use(billingRouter);

export default router;
