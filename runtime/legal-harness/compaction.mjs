import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
export default class LegalCompaction extends BasicCompactionEngine {
  async summarize(input, agent, signal) {
    const target = agent.session.requestHeader()?.config || agent.options;
    const assembler = new BlockAssembler();
    const options = {
      provider: target.provider, model: target.model,
      messages: [...input.messages, { role: 'user', content: [{ type: 'text', text: process.env.LEGAL_COMPACTION_PROMPT }] }],
      toolHistory: agent.session.toolHistory(), ...(input.tools ? { tools: [...input.tools] } : {}),
      maxTokens: 6000, sessionId: agent.session.id, purpose: 'compaction', signal,
    };
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    if (['error', 'aborted', 'max-tokens'].includes(assembler.finish.kind)) throw new Error('Legal checkpoint could not be completed');
    const rawOutput = assembler.blocks(), summary = rawOutput.filter(b => b.type === 'text' && b.text.trim());
    if (!summary.length) throw new Error('Legal checkpoint returned no text');
    return { summary, rawOutput, llmStreamCall: true, provider: options.provider, model: options.model, maxTokens: options.maxTokens, ...(assembler.usage ? { usage: assembler.usage } : {}) };
  }
}
