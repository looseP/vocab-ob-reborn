/**
 * L3 路由组合器（2026-09-08 自单文件 l3.ts 拆分，499/500 复杂度门禁触顶）。
 * 原路径与语义逐一保留：/api/l3/* 下 30 个端点分挂 6 个资源域子路由。
 * HTTP 保持薄层：解析 body/query、附加 auth userId、只调用 service。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { contextsRoutes } from "./contexts";
import { importsRoutes } from "./imports";
import { proposalsRoutes } from "./proposals";
import { readsRoutes } from "./reads";
import { recommendationsRoutes } from "./recommendations";
import { sourcesRoutes } from "./sources";

export function l3Routes(services: Services) {
  const app = new Hono<AppEnv>();
  app.route("/", sourcesRoutes(services));
  app.route("/", contextsRoutes(services));
  app.route("/", readsRoutes(services));
  app.route("/", importsRoutes(services));
  app.route("/", proposalsRoutes(services));
  app.route("/", recommendationsRoutes(services));
  return app;
}
