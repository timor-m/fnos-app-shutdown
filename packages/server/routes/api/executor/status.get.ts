import { defineEventHandler } from "h3";
import { ok } from "../../../utils/api-response";
import { readExecutorStatus } from "../../../services/executor.service";

export default defineEventHandler(async () => {
  const { state, status, statusReadError } = await readExecutorStatus();
  return ok({ state, status, statusReadError });
});
