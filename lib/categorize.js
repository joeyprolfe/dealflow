const BRANCHES = [
  { name: 'Due Diligence',      keywords: ['due diligence', 'dd ', ' dd,', 'data room', 'audit', 'disclosure', 'cap table', 'financial statement', 'tech dd', 'customer', 'concentration'] },
  { name: 'Term Sheet',         keywords: ['term sheet', 'termsheet', 'loi', 'letter of intent', 'offer', 'proposal', 'pre-money', 'post-money', 'valuation', 'liquidation'] },
  { name: 'Legal & Compliance', keywords: ['legal', 'counsel', 'attorney', 'spa', 'agreement', 'contract', 'nda', 'confidentiality', 'clause', 'representation', 'warranty', 'indemnity', 'cp ', 'condition precedent'] },
  { name: 'Financials',         keywords: ['financial', 'model', 'revenue', 'ebitda', 'arr', 'mrr', 'cash flow', 'irr', 'projection', 'forecast', 'p&l', 'balance sheet', 'dcf', 'valuation model'] },
  { name: 'Closing',            keywords: ['closing', 'completion', 'signing', 'sign', 'execute', 'settlement', 'locked box', 'completion accounts', 'wires', 'drawdown'] },
  { name: 'Financing',          keywords: ['financing', 'debt', 'facility', 'loan', 'capital', 'commitment letter', 'mezzanine', 'senior', 'tranche', 'lbo'] },
  { name: 'Management',         keywords: ['management', 'ceo', 'cto', 'cfo', 'founder', 'team', 'incentive', 'mip', 'retention', 'earnout', 'option pool'] },
  { name: 'Regulatory',         keywords: ['regulatory', 'accc', 'asic', 'sec', 'compliance', 'filing', 'approval', 'clearance', 'antitrust', 'competition'] },
  { name: 'Board Approval',     keywords: ['board', 'resolution', 'vote', 'directors', 'board pack', 'board meeting', 'approval', 'exclusivity'] },
  { name: 'Integration',        keywords: ['integration', 'day 1', 'readiness', 'erp', 'migration', 'org structure', 'synergy', 'combined'] },
  { name: 'Investor Relations', keywords: ['investor', 'lp ', 'limited partner', 'sequoia', 'venture', 'vc ', 'pitch', 'roadshow', 'deck'] },
]

/**
 * Given an email and a list of deal definitions, returns an array of matches.
 * Each match: { dealId, dealName, dealColor, branch }
 * An email can match multiple deals and multiple branches.
 */
export function categorizeEmail(email, deals) {
  const text = `${email.subject || ''} ${email.bodyPreview || ''} ${email.body?.content || ''}`.toLowerCase()
  const results = []

  for (const deal of deals) {
    if (!deal.keywords?.length) continue
    const dealScore = deal.keywords.filter(kw => text.includes(kw.toLowerCase())).length
    if (dealScore === 0) continue

    // Find matching branches
    const matchedBranches = BRANCHES.filter(b =>
      b.keywords.some(kw => text.includes(kw))
    )
    const branch = matchedBranches.length > 0
      ? matchedBranches[0].name
      : 'Correspondence'

    results.push({
      dealId: deal.id,
      dealName: deal.name,
      dealColor: deal.color,
      branch,
      score: dealScore,
    })
  }

  return results.sort((a, b) => b.score - a.score)
}
