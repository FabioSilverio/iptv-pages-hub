# X Auto-Retweet

Automatiza retweets de uma conta especifica do X (Twitter).

## Setup

1. Crie uma conta de desenvolvedor em https://developer.twitter.com
2. Crie um projeto/app e obtenha as chaves da API
3. Copie `.env.example` para `.env` e preencha suas chaves:
   - `TWITTER_API_KEY`
   - `TWITTER_API_SECRET`
   - `TWITTER_ACCESS_TOKEN`
   - `TWITTER_ACCESS_SECRET`
   - `TWITTER_BEARER_TOKEN`

## Como usar

```bash
npm install
npm run dev
```

Abra http://localhost:3000

1. Cole o ID da conta que voce quer retuitar automaticamente
2. Ative o toggle "Retweet automatico"
3. Clique em "Salvar e Ativar"

O sistema verifica a cada 60 segundos por novos tweets da conta alvo e retuita automaticamente.

## Notas

- Nao retuita replies ou retweets da conta alvo, so tweets originais
- Verifica a cada 60 segundos
- Estatisticas sao salvas localmente
