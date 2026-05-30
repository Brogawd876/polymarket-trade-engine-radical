import { existsSync } from "fs";
import { TerminalAccessError, isBlockedBody } from "./errors";

const CURL =
  process.platform === "darwin"
    ? "/opt/homebrew/opt/curl/bin/curl"
    : process.platform === "win32"
      ? "C:\\Windows\\System32\\curl.exe"
      : "/usr/bin/curl";

async function curlFetch(
  url: string | URL,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  if (!existsSync(CURL)) {
    throw new Error(`Critical dependency missing: curl not found at ${CURL}. Please ensure curl is installed and accessible at this path.`);
  }

  const args = ["-s", "-L"];
  for (const [key, value] of Object.entries(headers ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url.toString());

  const proc = Bun.spawn([CURL, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (signal) {
    signal.addEventListener("abort", () => proc.kill());
  }

  const [body, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`curl exited ${exitCode}: ${stderr}`);
  }
  return new Response(body, { status: 200 });
}

export class MaintenanceError extends Error {
  constructor(message: string, public readonly status: number = 425) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export async function fetchWithRetry<T = Response>(
  url: string | URL,
  params?: {
    options?: BunFetchRequestInit;
    resolveWhen?: (res: Response) => Promise<T>;
    totalRetry?: number;
    retryBackOff?: (currentRetry: number) => number;
    _currentRetry?: number;
    useCurl?: boolean;
    abort?: AbortSignal;
    sleep?: (millis: number) => Promise<void>;
    /** Called on every fetch error before retrying. Throw or call process.exit() to abort. */
    onError?: (err: unknown) => void;
  },
): Promise<T> {
  function sleep(millis: number) {
    return new Promise((r) => setTimeout(r, millis));
  }

  const _params = params ?? {};
  const retryTimes = _params.totalRetry ?? 3;
  const currentRetry = _params._currentRetry ?? 0;

  if (_params.abort?.aborted) return undefined as T;

  try {
    const res = _params.useCurl
      ? await curlFetch(
          url,
          _params.options?.headers as Record<string, string>,
          _params.abort,
        )
      : await fetch(url, _params.options);

    if (res.status === 403) {
      const body = await res.text();
      throw new TerminalAccessError(
        `Access Forbidden (403): Polymarket access appears to be blocked from this network or region.`,
        403,
        body,
      );
    }

    if (res.status === 425) {
      // Polymarket maintenance / too early / matching engine restart
      throw new MaintenanceError(
        `HTTP 425: Polymarket matching engine is restarting or in maintenance.`,
      );
    }

    if (!res.ok) {
      const body = await res.text();
      if (isBlockedBody(body)) {
        throw new TerminalAccessError(
          `Access Blocked: The response body indicates region or access restrictions.`,
          res.status,
          body,
        );
      }
      throw Error(body);
    }

    if (params?.resolveWhen) {
      return await params.resolveWhen(res);
    } else {
      return res as T;
    }
  } catch (e) {
    // do not retry on abort
    if (e instanceof DOMException && e.name === "AbortError")
      return undefined as T;

    // do not retry on terminal access errors
    if (e instanceof TerminalAccessError) {
      throw e;
    }

    // Maintenance handling: aggressive exponential backoff
    if (e instanceof MaintenanceError) {
        if (retryTimes - currentRetry <= 0) throw e;
        const delay = 5000 * Math.pow(2, currentRetry); // Start at 5s for maintenance
        if (params?.onError) params.onError(e);
        await (params?.sleep ?? sleep)(delay);
        return await fetchWithRetry(url, {
            ..._params,
            _currentRetry: currentRetry + 1,
            totalRetry: Math.max(retryTimes, 10), // Allow more retries for maintenance
        });
    }

    // caller-supplied error hook (may call process.exit or throw to stop retrying)
    if (params?.onError) params.onError(e);

    // retry
    if (retryTimes - currentRetry <= 0) throw e;
    let delay: number;
    if (params?.retryBackOff) {
      delay = params.retryBackOff(currentRetry);
    } else {
      delay = 1000 * Math.pow(2, currentRetry);
    }
    if (_params.abort?.aborted) return undefined as T;
    await (params?.sleep ?? sleep)(delay);
    return await fetchWithRetry(url, {
      ..._params,
      _currentRetry: currentRetry + 1,
    });
  }
}
