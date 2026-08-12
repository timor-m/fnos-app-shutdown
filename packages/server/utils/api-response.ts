export function ok<T>(data: T, meta?: Record<string, unknown>) {
  return {
    ok: true,
    data,
    ...(meta ? { meta } : {})
  };
}

export function fail(message: string, meta?: Record<string, unknown>) {
  return {
    ok: false,
    error: {
      message
    },
    ...(meta ? { meta } : {})
  };
}
