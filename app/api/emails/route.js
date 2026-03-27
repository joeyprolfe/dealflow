import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET(request) {
  const session = await getServerSession(authOptions)

  if (!session?.accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const folderId = searchParams.get('folderId') || 'inbox'
  const since = searchParams.get('since') // ISO date string e.g. "2024-01-01"

  const filter = since
    ? `&$filter=receivedDateTime ge ${new Date(since).toISOString()}`
    : ''

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages` +
    '?$top=100' +
    '&$orderby=receivedDateTime desc' +
    `${filter}` +
    '&$select=id,subject,bodyPreview,from,receivedDateTime,conversationId,isRead',
    { headers: { Authorization: `Bearer ${session.accessToken}` } }
  )

  if (!res.ok) {
    const err = await res.json()
    return Response.json({ error: err.error?.message || 'Graph error' }, { status: res.status })
  }

  const data = await res.json()
  return Response.json({ emails: data.value || [] })
}
