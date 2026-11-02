import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

function App() {
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
    <main style={{ fontFamily: 'Arial, sans-serif', padding: '40px' }}>
      <h1>Growth Intelligence</h1>
      <h2>Supabase verbindingstest</h2>
      {error ? (
        <p role="alert">Fout: {error}</p>
      ) : (
        <p>{message}</p>
      )}
    </main>
  )
}

export default App
