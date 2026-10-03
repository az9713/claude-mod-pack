// The /mods command as a pure function: text in, text and new overrides out.
// register.tsx stores the overrides when `isChanged` is true.

import type { PluginOptions } from 'claude-code'

import type { Feature } from './feature'
import { isFeatureOn, isSoundOn, NO_OVERRIDES, type Overrides } from './settings'

export type ModsResult = { text: string; overrides: Overrides; isChanged: boolean }

type Listed = Pick<Feature, 'id' | 'title' | 'about' | 'usesModel' | 'hasSound' | 'defaultOn'>

const USAGE = [
  'Usage:',
  '  /mods                     list the features',
  '  /mods on <id>             turn a feature on',
  '  /mods off <id>            turn a feature off',
  '  /mods toggle <id>         flip a feature',
  '  /mods sound on|off        the global sound switch',
  '  /mods reset               drop every /mods choice and use the settings again',
].join('\n')

// `last`: what a feature says of its last outcome, by feature id (`Feature.last`). The list shows it
// under a feature that is ON. The default is no feature saying anything.
export const runMods = (args: string, features: readonly Listed[], overrides: Overrides, options: PluginOptions, last: Readonly<Record<string, string>> = {}): ModsResult => {
  const [verb = '', arg = '', ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const unchanged = (text: string): ModsResult => ({ text, overrides, isChanged: false })
  const changed = (text: string, next: Overrides): ModsResult => ({ text, overrides: next, isChanged: true })
  const known = features.map(f => f.id).join(', ')

  const list = () => {
    const lines = features.map(f => {
      const flags = [f.usesModel ? 'uses model tokens' : '', f.hasSound ? 'plays sound' : ''].filter(Boolean)
      const isOn = isFeatureOn(f, overrides, options)
      const line = `  ${isOn ? 'ON ' : 'OFF'}  ${f.id}  ${f.title}: ${f.about}${flags.length ? ` [${flags.join(', ')}]` : ''}`
      return isOn && last[f.id] ? `${line}\n    last: ${last[f.id]}` : line
    })
    return [`mod-pack features (sound: ${isSoundOn(overrides, options) ? 'ON' : 'OFF'}):`, ...lines, '', 'Type /mods help for the commands.'].join('\n')
  }

  if (verb === '' || verb === 'list') return arg || rest.length ? unchanged(USAGE) : unchanged(list())
  if (verb === 'help') return unchanged(USAGE)

  if (verb === 'reset') {
    return arg ? unchanged(USAGE) : changed('mod-pack: every /mods choice is cleared. The settings apply again.', NO_OVERRIDES)
  }

  if (verb === 'sound') {
    if ((arg !== 'on' && arg !== 'off') || rest.length) return unchanged(USAGE)
    const note = arg === 'on' ? ' Only features that are ON and can play sound will play one. Claude Code plays plugin sound only where it has a player (macOS).' : ''
    return changed(`mod-pack: sound is ${arg.toUpperCase()}.${note}`, { ...overrides, sound: arg === 'on' })
  }

  if (verb === 'on' || verb === 'off' || verb === 'toggle') {
    if (!arg || rest.length) return unchanged(USAGE)
    const feature = features.find(f => f.id === arg)
    if (!feature) return unchanged(`mod-pack: no feature named "${arg}". Known: ${known}.`)
    const isOn = verb === 'toggle' ? !isFeatureOn(feature, overrides, options) : verb === 'on'
    return changed(`mod-pack: ${feature.id} is ${isOn ? 'ON' : 'OFF'}.`, { ...overrides, features: { ...overrides.features, [feature.id]: isOn } })
  }

  return unchanged(`mod-pack: "${verb}" is not a command.\n${USAGE}`)
}
