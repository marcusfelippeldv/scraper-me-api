# Scraper Mercado Eletrônico - API

API para buscar oportunidades no Mercado Eletrônico por palavra-chave.

## Endpoints

### GET /
Status da API

### GET /health
Health check

### POST /buscar
Buscar oportunidades por keyword

**Body:**
```json
{
  "keyword": "sensor",
  "salvarNoBanco": true
}
```

**Resposta:**
```json
{
  "success": true,
  "keyword": "sensor",
  "total": 50,
  "salvosNoBanco": 50,
  "oportunidades": [...]
}
```

## Variáveis de Ambiente

Configure no Railway:

| Variável | Descrição |
|----------|-----------|
| ME_USUARIO | Usuário do Mercado Eletrônico |
| ME_SENHA | Senha do Mercado Eletrônico |
| WEBHOOK_URL | URL do webhook Supabase |
| SCRAPER_TOKEN | Token de autenticação |

## Deploy no Railway

1. Conecte seu repositório GitHub ao Railway
2. Configure as variáveis de ambiente
3. Deploy automático!
