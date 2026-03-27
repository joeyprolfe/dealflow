import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import Groq from 'groq-sdk'

export async function POST(request) {
  const session = await getServerSession(authOptions)
  if (!session?.accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { emails } = await request.json()
  if (!emails?.length) return Response.json({ suggestions: [] })

  const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

  const emailList = emails.slice(0, 200).map((e, i) =>
    `${i + 1}. "${e.subject || '(no subject)'}" — ${(e.bodyPreview || '').slice(0, 100)}`
  ).join('\n')

  const total = emails.length

  const msg = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: 'You are an expert at analysing deal professional email inboxes (M&A, investments, finance, legal). You return only valid JSON, no markdown, no explanation.',
      },
      {
        role: 'user',
        content: `Analyse these ${total} emails and identify distinct deals, projects, or recurring topics. Optimise for the FEWEST categories (3–8) that still accurately describe them.

Emails:
${emailList}

Return ONLY a JSON array, no markdown:
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
- keywords must actually appear in the subjects/previews above
- proportion = fraction of the ${total} total emails this covers (decimals, must sum to ≤ 1.0)
- count = estimated number of emails in this category
- Use distinct colors from: #4fc3f7 #9c6dff #00d98b #ff6b6b #ffa657 #f78166 #79c0ff #56d364
- Sort by count descending`,
      },
    ],
  })

  try {
    const text = msg.choices[0].message.content.trim()
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const suggestions = JSON.parse(json)
    return Response.json({ suggestions, total })
  } catch (e) {
    return Response.json({ error: 'Could not parse suggestions', raw: msg.choices[0].message.content }, { status: 500 })
  }
}
