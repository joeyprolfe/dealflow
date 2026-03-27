import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET() {
  const session = await getServerSession(authOptions)

  if (!session?.accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me/mailFolders?$top=50&$select=id,displayName,totalItemCount,unreadItemCount',
    { headers: { Authorization: `Bearer ${session.accessToken}` } }
  )

  if (!res.ok) {
    const err = await res.json()
    return Response.json({ error: err.error?.message || 'Graph error' }, { status: res.status })
  }

  const data = await res.json()
  return Response.json({ folders: data.value || [] })
}
