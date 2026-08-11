import { Router, type IRouter } from "express";
import healthRouter from "./health";
import readingsRouter from "./readings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(readingsRouter);

export default router;
