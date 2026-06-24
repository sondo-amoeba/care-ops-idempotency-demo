import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-request";

type RouteContext = { params: Promise<{ path: string[] }> };

async function handler(request: NextRequest, { params }: RouteContext) {
  const { path } = await params;
  return proxyToApi(request, `/care-ops/${path.join("/")}`);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
