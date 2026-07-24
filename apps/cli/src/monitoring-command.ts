export function isMonitoringCommand(args: string[]): boolean {
  return args[0] === "events" && (args[1] === "tail" || args[1] === "stream");
}
