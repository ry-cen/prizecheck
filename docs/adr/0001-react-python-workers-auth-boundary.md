# React frontend, Python API, and internal Better Auth Worker

**Status:** superseded by [ADR 0002](0002-defer-deployment-provider-selection.md) for deployment topology. The React/Python/Better Auth stack remains selected.

The MVP uses React, TypeScript, and Vite for the frontend, a Python/FastAPI Cloudflare Worker for application routes, and an internal TypeScript Cloudflare Worker for Better Auth. The owner chose Python over Go while keeping the low-idle-cost Cloudflare/Neon/R2 topology; Better Auth requires a JavaScript/TypeScript server, so a Service Binding keeps its boundary internal and same-origin. Pydantic/OpenAPI defines application contracts and generates React client types. Try Workers Free first, then use measured CPU and load results to decide whether a paid Worker tier is needed before launch.
