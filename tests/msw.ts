import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export { http, HttpResponse };
export const server = setupServer();
