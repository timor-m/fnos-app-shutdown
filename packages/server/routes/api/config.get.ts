import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { readConfig } from "../../services/config.service";

export default defineEventHandler(async () => {
  const { config, fallback } = await readConfig();
  return ok({ config, fallback });
});
