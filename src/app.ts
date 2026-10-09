import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// API responses are per-user and change constantly (credit balance, reading
// history). Express's default ETags let iOS revalidate cached copies and get
// a bodiless 304, which the mobile client treats as an error — so the Home
// balance showed "—". Never let clients or proxies cache API responses.
app.set("etag", false);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api", router);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Catch-all error handler: guarantees every unhandled exception (Gemini/ffmpeg
// failures, DB errors, etc.) returns clean JSON instead of Express's default
// HTML error page. Must be registered last, with 4 args, for Express to treat
// it as an error handler.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log?.error({ err }, "Unhandled error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

export default app;
