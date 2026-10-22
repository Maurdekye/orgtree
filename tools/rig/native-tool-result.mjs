// fakecli display text joins MCP blocks. Decode only the correlated original
// response: a primary text block and, optionally, the exact timing block.
import { isDeepStrictEqual } from 'node:util'

export function nativeToolText(log, call, tool, { toolUseId, args } = {}) {
  if (!Number.isInteger(call?.pid) || call.pid <= 0) throw Error('missing native fake CLI process identity')
  if (call.tool !== tool) throw Error('native fake CLI tool identity differs')
  if (toolUseId !== undefined && (typeof toolUseId !== 'string' || !toolUseId)) throw Error('missing native tool-use identity')
  const requests = log.filter(e => e.kind === 'send' && e.pid === call.pid
    && e.line?.type === 'control_request' && e.line.request?.subtype === 'mcp_message'
    && e.line.request.server_name === 'orgtree' && e.line.request.message?.method === 'tools/call'
    && e.line.request.message.params?.name === tool
    && (toolUseId === undefined || e.line.request.message.params?._meta?.['claudecode/toolUseId'] === toolUseId))
  if (requests.length !== 1) throw Error('expected exactly one native self-tool MCP request')
  const request = requests[0].line
  if (args !== undefined && (!isDeepStrictEqual(request.request.message.params.arguments, args)
    || !isDeepStrictEqual(call.args, args))) throw Error('native MCP arguments differ from scripted call')
  const requestId = request.request_id
  if (typeof requestId !== 'string' || !requestId) throw Error('missing native MCP request id')
  const responses = log.filter(e => e.kind === 'recv' && e.pid === call.pid
    && e.line?.type === 'control_response' && e.line.response?.request_id === requestId)
  if (responses.length !== 1) throw Error('expected exactly one correlated native MCP response')
  const response = responses[0].line.response
  const rpc = response.response?.mcp_response
  if (response.subtype !== 'success' || rpc?.error != null
    || rpc?.id !== request.request.message.id) throw Error('invalid native MCP response envelope')
  const result = rpc?.result
  const content = result?.content
  if (!Array.isArray(content) || content.length < 1 || content.length > 2
    || content.some(c => c.type !== 'text' || typeof c.text !== 'string')) throw Error('invalid native MCP text blocks')
  if (content.length === 2 && content[1].text.match(/^execution time: [0-9]+\.[0-9]{3}ms$/)?.[0] !== content[1].text) {
    throw Error('unexpected native MCP trailing block')
  }
  if (call.text !== content.map(c => c.text).join('\n')
    || call.is_error !== (result.isError ?? false)) throw Error('native MCP response differs from fake CLI result')
  return content[0].text
}

export function nativeToolJson(log, call, tool, options) {
  return JSON.parse(nativeToolText(log, call, tool, options))
}
