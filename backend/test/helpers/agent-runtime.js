const { randomUUID } = require('node:crypto');

// This fixture exercises business tools and persistence, never legal accuracy.
async function emptyReview({ context, documents }) {
  return {
    async run() {
      for (const document of documents) {
        let cursor = { versionId: document.versionId };
        do {
          const result = await context.execute('read_document', cursor, randomUUID());
          if (result.error) throw new Error(result.error);
          cursor = result.next;
        } while (cursor);
      }
      const report = {
        summary: '工程模拟：只验证工具、文件和任务状态。', contractType: '工程测试',
        reviewedVersionIds: documents.map(d => d.versionId), limitations: ['模拟模型不验证法律质量'], findings: [],
      };
      if (context.manifest.revisionReview) {
        let offset = 0, text = '';
        do {
          const page = await context.execute('read_revision_baseline', { offset }, randomUUID());
          if (page.error) throw new Error(page.error);
          text += page.content; offset = page.nextOffset;
        } while (offset !== null);
        const baseline = JSON.parse(text);
        report.findings = baseline.findings.filter(f => f.disposition?.action !== 'reject').map(f => ({ title: f.title, status: 'uncertain', severity: f.severity, kind: 'uncertain', reason: '工程模拟：不作法律判断。', suggestion: '', evidence: [], legalSourceIds: [] }));
        let index = 0;
        report.revisionReview = { baselineReviewId: baseline.reviewId, items: baseline.findings.map(f => ({ previousFindingId: f.id, status: f.disposition?.action === 'reject' ? 'accepted' : 'uncertain', reason: '工程模拟：保留人工处理，其余项等待核实。', evidence: [], findingIndexes: f.disposition?.action === 'reject' ? [] : [index++], ...(f.previousResolution?.status === 'resolved' ? { reopenReason: '工程模拟不作法律判断，此项需在真实模型验收时核实。' } : {}) })), newFindings: [] };
      }
      const result = await context.execute('submit_review', { report }, randomUUID());
      if (!result.submitted) throw new Error(result.error || 'REPORT_NOT_SAVED');
      return {};
    },
    async close() {},
  };
}
module.exports = { emptyReview };
