import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(request) {
  const session = await getServerSession(authOptions)
  if (!session?.accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { emails } = await request.json()
  if (!emails?.length) return Response.json({ suggestions: [] })

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const emailList = emails.slice(0, 200).map((e, i) =>
    `${i + 1}. "${e.subject || '(no subject)'}" — ${(e.bodyPreview || '').slice(0, 100)}`
  ).join('\n')

  const total = emails.length

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are analyzing ${total} emails from a deal professional's inbox (M&A, investments, finance, legal).

Here are the emails:
${emailList}

Identify the distinct deals, projects, or recurring topics. Optimise for the FEWEST categories that still accurately describe them — aim for 3–8 total. Each category should be meaningfully distinct.

Return ONLY valid JSON, no markdown fences:
[
  {
    "name": "Short deal or project name",
    "description": "One sentence description",
    "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
    "count": 14,
    "proportion": 0.28,
    "color": "#4fc3f7"
  }
]

Rules:
- keywords must be words or short phrases that actually appear in the subjects/previews
- proportion = fraction of the ${total} total emails this category covers (must sum to ≤ 1.0)
- count = estimated number of emails in this category
- Use distinct colors from: #4fc3f7 #9c6dff #00d98b #ff6b6b #ffa657 #f78166 #79c0ff #56d364
- Sort by count descending`
    }]
  })

  try {
    const text = msg.content[0].text.trim()
    // Strip markdown fences if Claude adds them anyway
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const suggestions = JSON.parse(json)
    return Response.json({ suggestions, total })
  } catch (e) {
    return Response.json({ error: 'Could not parse suggestions', raw: msg.content[0].text }, { status: 500 })
  }
}
