/** Privacy-safe diagnostics for client-issued service termination.
 *
 * Only identifiers, versions, process IDs and coarse causes are recorded. URLs (which can carry
 * credentials), passwords and session content are never included.
 */

export type TerminationCause = "unresponsive" | "version-mismatch" | "explicit-stop"

export type TerminationContext = {
  readonly cause: TerminationCause
  /** Number of consecutive failed probes that triggered an unresponsive termination. */
  readonly streak?: number
  /** Wall-clock milliseconds covered by that probe streak. */
  readonly windowMs?: number
  /** Version that the caller required when replacing a service. */
  readonly previousVersion?: string
  /** Restart-lock token held by the caller, when this termination is part of a reboot. */
  readonly restartToken?: string
}

export type TerminationFields = {
  readonly event: "service.terminate"
  readonly signal: "SIGTERM" | "SIGKILL"
  readonly targetPID: number
  readonly registrationID: string
  readonly serviceVersion: string
  readonly callerPID: number
  readonly cause: TerminationCause
  readonly streak?: number
  readonly windowMs?: number
  readonly previousVersion?: string
  readonly restartToken?: string
}

/** Build the single structured record emitted when a client signals a service process. */
export function terminationFields(
  info: { readonly id?: string; readonly version?: string; readonly pid: number },
  context: TerminationContext,
  signal: "SIGTERM" | "SIGKILL",
  callerPID: number = process.pid,
): TerminationFields {
  return {
    event: "service.terminate",
    signal,
    targetPID: info.pid,
    registrationID: info.id ?? "unknown",
    serviceVersion: info.version ?? "unknown",
    callerPID,
    cause: context.cause,
    ...(context.streak === undefined ? {} : { streak: context.streak }),
    ...(context.windowMs === undefined ? {} : { windowMs: context.windowMs }),
    ...(context.previousVersion === undefined ? {} : { previousVersion: context.previousVersion }),
    ...(context.restartToken === undefined ? {} : { restartToken: context.restartToken }),
  }
}
