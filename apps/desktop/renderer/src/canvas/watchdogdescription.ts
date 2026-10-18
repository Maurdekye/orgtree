import type { Watchdog } from '../types'

// Presentation only. Match the native runners, not the shared storage shape:
// fair_queue is pushed mail, process ignores regex, and silence counts matches.
// Full target/pattern remain expanded below even if the lead needs a short form.
const short = (text: string) => text.length > 160 ? text.slice(0, 159) + '…' : text

export function watchdogDescription(dog: Watchdog) {
  const target = short(dog.target)
  const pattern = dog.pattern ? `matching /${short(dog.pattern)}/` : 'matching'
  const lineMatch = dog.pattern ? `matches /${short(dog.pattern)}/` : 'is nonempty'
  const alert = dog.notice ? `sends passive mail to ${dog.owner}` : `wakes ${dog.owner}`
  const silence = dog.fire_mode === 'silence'
  const quiet = dog.quiet_period_s == null ? 'the configured quiet period (duration unavailable)' : `${dog.quiet_period_s}s`
  const types: Record<Watchdog['kind'], string> = {
    file: 'File listener', command: 'Periodic command listener', process: 'Process listener',
    stream: 'Stream listener', activity: 'Activity listener',
    event: `Orgtree event listener · ${target}`, fair_queue: 'Mail queue listener',
  }
  const labels: Record<Watchdog['kind'], string> = {
    file: 'watched file', command: 'command (each interval)', process: 'watched process',
    stream: 'listening command (realtime)', activity: 'watched agent', event: 'engine event', fair_queue: 'project',
  }
  const count = dog.kind === 'event' && ['agents.active', 'agents.live'].includes(dog.target)
  const scope = dog.event_scope === 'org' ? 'visible organization' : 'visible subtree'
  const counted = dog.target === 'agents.active' ? 'agents in turns' : 'live agents'
  let summary: string
  switch (dog.kind) {
    case 'file': summary = `Watches new ${dog.pattern ? `lines ${pattern}` : 'nonempty lines'} appended to ${target} and ${alert}.`; break
    case 'command': summary = `Runs “${target}” every ${dog.interval_s}s and ${alert} when an output line ${lineMatch}.`; break
    case 'process': summary = `Watches ${target} and ${alert} on an observed transition from up to down. A target already down must first be seen up.`; break
    case 'stream': summary = `Runs one long-lived command, “${target}”, and ${alert} when an output line ${lineMatch}.`; break
    case 'activity': summary = `Watches ${target}’s turns and tool calls and ${alert} on ${pattern} activity events.`; break
    case 'event': summary = count && dog.threshold
      ? `Watches ${target} and ${alert} when the count of ${counted} crosses ${dog.threshold} in the ${scope}, excluding ${dog.owner}${dog.pattern ? `, with an event payload ${pattern}` : ''}. Staying across the threshold does not fire again.`
      : count
        ? `Watches ${target} and ${alert} when the count of ${counted} changes in the ${scope}, excluding ${dog.owner}${dog.pattern ? `, with an event payload ${pattern}` : ''}.`
        : `Listens for ${target} and ${alert} when ${pattern} engine events arrive.`; break
    case 'fair_queue': summary = `Delivers mail waiting in project ${target} to ${dog.owner}, one message at a time, shared fairly with other armed listeners. Each message goes to one listener, the least recently served first.`; break
  }
  if (silence && dog.kind !== 'fair_queue') {
    const source = dog.kind === 'file' ? `${pattern} appended lines in ${target}`
      : dog.kind === 'command' || dog.kind === 'stream' ? `${pattern} output lines from “${target}”`
      : dog.kind === 'process' ? `an observed up-to-down transition from ${target}`
      : dog.kind === 'activity' ? `${pattern} turns and tool calls from ${target}`
      : `${pattern} ${target} engine events`
    summary = `${alert[0].toUpperCase() + alert.slice(1)} after ${quiet} without ${source}. Only matching events reset this timer; other activity does not.`
  }
  const polling = ['file', 'command', 'process'].includes(dog.kind)
  const cadence = dog.kind === 'fair_queue' ? 'Delivered when project mail is waiting; no polling interval.'
    : polling ? `Checked every ${dog.interval_s}s`
    : silence ? 'Listens continuously; alerts follow the silence timer.'
    : `Listens continuously · minimum alert gap ${dog.interval_s}s (at most one alert per gap)`
  const delivery = dog.notice
    ? `Passive mail waits for the next turn and does not wake ${dog.owner}.`
    : dog.kind === 'fair_queue'
      ? `Ordinary mail wakes ${dog.owner}; messages originally sent as passive notices remain passive.`
      : `Alert mail wakes ${dog.owner}.`
  const fireMode = silence
    ? `fires after ${quiet} of silence — ${quiet} without a matching event; resets after each match and fire`
    : dog.kind === 'fair_queue' ? 'on each assigned project message'
    : dog.kind === 'process' ? 'on an observed up-to-down transition'
    : dog.kind === 'command' ? 'on matching output or a command timeout'
    : dog.kind === 'file' ? 'on new matching appended lines'
    : 'on a matching event'
  const patternLabel = silence ? 'events that reset the silence timer'
    : dog.kind === 'event' ? 'event payload matching'
    : dog.kind === 'activity' ? 'activity lines matching' : 'fires on lines matching'
  return { type: types[dog.kind], targetLabel: labels[dog.kind], summary, cadence, delivery, fireMode, patternLabel, polling }
}
