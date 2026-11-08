import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Bestaande verbindingstest: leest één testbericht uit de tabel `connection_test`.
export function SupabaseStatus() {
  const [message, setMessage] = useState('Verbinden met Supabase...')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function testConnection() {
      const { data, error } = await supabase
        .from('connection_test')
        .select('message')
        .limit(1)
        .maybeSingle()

      if (error) {
        setError(error.message)
        return
      }

      setMessage(data?.message ?? 'Geen testbericht gevonden.')
    }

    void testConnection()
  }, [])

  return (
    <p className="status">
      Supabase-verbinding:{' '}
      {error ? <span role="alert">Fout: {error}</span> : <span>{message}</span>}
    </p>
  )
}
