// server.js
// API do Scraper Mercado Eletrônico para Railway

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configurações
const CONFIG = {
  loginUrl: 'https://me.com.br/do/Login.mvc/LoginNew',
  oportunidadesUrl: 'https://me.com.br/supplier/inbox/pendencies/3',
  usuario: process.env.ME_USUARIO || '3791A8D5',
  senha: process.env.ME_SENHA || 'Frai@Sensor1007',
  webhookUrl: process.env.WEBHOOK_URL || 'https://pjjciitfhnhshxtxyixa.supabase.co/functions/v1/receive-webhook',
  scraperToken: process.env.SCRAPER_TOKEN || 'sensorvix-scraper-2026',
  timeout: 60000
};

// Logger
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Status da API
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Scraper Mercado Eletrônico - Sensorvix',
    endpoints: {
      'GET /': 'Status da API',
      'POST /buscar': 'Buscar oportunidades por keyword',
      'GET /health': 'Health check'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Endpoint principal: buscar por keyword
app.post('/buscar', async (req, res) => {
  const { keyword, salvarNoBanco = true } = req.body;
  
  if (!keyword) {
    return res.status(400).json({ success: false, error: 'Keyword é obrigatória' });
  }
  
  log(`🔍 Recebida requisição de busca: "${keyword}"`);
  
  try {
    const oportunidades = await executarScraper(keyword);
    
    let webhookResult = null;
    if (salvarNoBanco && oportunidades.length > 0) {
      webhookResult = await enviarParaWebhook(oportunidades);
    }
    
    res.json({
      success: true,
      keyword: keyword,
      total: oportunidades.length,
      salvosNoBanco: webhookResult?.inserted || 0,
      oportunidades: oportunidades
    });
    
  } catch (error) {
    log(`❌ Erro: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Executar o scraper
async function executarScraper(keyword) {
  log('🚀 Iniciando scraper...');
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);
  
  try {
    // Login
    await doLogin(page);
    
    // Buscar oportunidades
    const oportunidades = await buscarOportunidades(page, keyword);
    
    log(`✅ Scraper finalizado: ${oportunidades.length} oportunidades`);
    return oportunidades;
    
  } finally {
    await browser.close();
  }
}

// Fazer login
async function doLogin(page) {
  log('🔐 Fazendo login...');
  
  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  // Preencher usuário
  const userInput = await page.$('input[placeholder="Insira seu login"], input[placeholder*="login"]');
  if (userInput) {
    await userInput.fill(CONFIG.usuario);
  }
  
  // Preencher senha
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    await passInput.fill(CONFIG.senha);
  }
  
  // Clicar em Entrar
  const btnEntrar = await page.$('button:has-text("Entrar")') || 
                    await page.$('button[type="submit"]');
  if (btnEntrar) {
    await btnEntrar.click();
  }
  
  await page.waitForTimeout(10000);
  log('✅ Login realizado');
}

// Buscar oportunidades
async function buscarOportunidades(page, keyword) {
  const oportunidades = [];
  
  const urlBusca = `${CONFIG.oportunidadesUrl}?term=${encodeURIComponent(keyword)}`;
  log(`   Acessando: ${urlBusca}`);
  
  await page.goto(urlBusca, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  
  let paginaAtual = 1;
  let temMaisPaginas = true;
  
  while (temMaisPaginas) {
    log(`   📄 Página ${paginaAtual}...`);
    
    const linhas = await extrairLinhasDaTabela(page, keyword);
    oportunidades.push(...linhas);
    
    log(`   Encontradas ${linhas.length} oportunidades na página ${paginaAtual}`);
    
    temMaisPaginas = await irParaProximaPagina(page);
    
    if (temMaisPaginas) {
      paginaAtual++;
      await page.waitForTimeout(3000);
      
      if (paginaAtual > 50) {
        log('   ⚠️ Limite de 50 páginas atingido');
        break;
      }
    }
  }
  
  return oportunidades;
}

// Extrair linhas da tabela
async function extrairLinhasDaTabela(page, keyword) {
  const oportunidades = [];
  
  try {
    await page.waitForTimeout(3000);
    
    const rows = await page.$$('table tbody tr');
    log(`   Linhas na tabela: ${rows.length}`);
    
    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i];
        
        const cells = await row.$$('td');
        const textos = [];
        
        for (const cell of cells) {
          const texto = await cell.textContent();
          textos.push(texto?.trim() || '');
        }
        
        const serialME = textos[1] || '';
        const tipoOportunidade = textos[2] || '';
        const cliente = textos[4] || '';
        const dataLimite = textos[5] || '';
        const localEntrega = textos[6] || '';
        
        // Clicar no "Ver Itens"
        let linkVerItens = await row.$('a:has-text("Ver Itens")');
        if (!linkVerItens) linkVerItens = await row.$('button:has-text("Ver Itens")');
        if (!linkVerItens) linkVerItens = await row.$('span:has-text("Ver Itens")');
        
        let itensDetalhes = { cotacao_id: '', qtd_itens_total: 0, itens: [] };
        if (linkVerItens) {
          await linkVerItens.click();
          await page.waitForTimeout(2000);
          
          itensDetalhes = await extrairItensDoPopup(page);
          
          // Fechar popup
          let btnFechar = await page.$('button[aria-label="Close"]');
          if (!btnFechar) btnFechar = await page.$('button[aria-label="close"]');
          if (!btnFechar) btnFechar = await page.$('svg[data-testid="CloseIcon"]');
          
          if (btnFechar) {
            await btnFechar.click();
          } else {
            await page.keyboard.press('Escape');
          }
          await page.waitForTimeout(1000);
        }
        
        const oportunidade = {
          serial_me: serialME,
          cotacao_id: itensDetalhes.cotacao_id,
          tipo_oportunidade: tipoOportunidade,
          cliente: cliente,
          data_limite: dataLimite,
          local_entrega: localEntrega,
          qtd_itens_total: itensDetalhes.qtd_itens_total,
          itens: itensDetalhes.itens,
          keyword_busca: keyword,
          origem: 'oportunidade_negocio',
          url: `https://me.com.br/supplier/inbox/pendencies/3?term=${keyword}`
        };
        
        if (serialME && serialME.match(/^\d+$/)) {
          oportunidades.push(oportunidade);
        }
        
      } catch (rowError) {
        log(`   ⚠️ Erro na linha ${i + 1}: ${rowError.message}`);
      }
    }
    
  } catch (error) {
    log(`   Erro ao extrair tabela: ${error.message}`);
  }
  
  return oportunidades;
}

// Extrair itens do popup
async function extrairItensDoPopup(page) {
  const resultado = {
    cotacao_id: '',
    qtd_itens_total: 0,
    itens: []
  };
  
  try {
    await page.waitForSelector('text=Lista de Itens', { timeout: 5000 });
    await page.waitForTimeout(1500);
    
    // Capturar título do popup: "Lista de Itens (2 itens) - Cotação #21710289"
    const tituloPopup = await page.$('text=/Lista de Itens.*Cotação/');
    if (tituloPopup) {
      const textoTitulo = await tituloPopup.textContent();
      
      const matchCotacao = textoTitulo.match(/#(\d+)/);
      if (matchCotacao) {
        resultado.cotacao_id = matchCotacao[1];
      }
      
      const matchQtd = textoTitulo.match(/\((\d+)\s*ite/i);
      if (matchQtd) {
        resultado.qtd_itens_total = parseInt(matchQtd[1]);
      }
      
      log(`   📋 Cotação #${resultado.cotacao_id} (${resultado.qtd_itens_total} itens)`);
    }
    
    let linhasPopup = await page.$$('[role="dialog"] table tbody tr');
    if (linhasPopup.length === 0) {
      linhasPopup = await page.$$('[class*="MuiDialog"] table tbody tr');
    }
    if (linhasPopup.length === 0) {
      linhasPopup = await page.$$('[class*="modal"] table tbody tr');
    }
    
    for (const linha of linhasPopup) {
      const cells = await linha.$$('td');
      
      if (cells.length >= 3) {
        const valores = [];
        for (const cell of cells) {
          const val = await cell.textContent();
          valores.push(val?.trim() || '');
        }
        
        const item = {
          numero: valores[0] || '',
          descricao: valores[1] || '',
          unidade: valores[2] || '',
          quantidade: valores[3] || ''
        };
        
        if (item.descricao && item.descricao.length > 0 && item.descricao !== 'Descrição') {
          resultado.itens.push(item);
        }
      }
    }
    
  } catch (error) {
    log(`   Erro ao extrair popup: ${error.message}`);
  }
  
  return resultado;
}

// Navegar para próxima página
async function irParaProximaPagina(page) {
  try {
    const btnProximo = await page.$('button[aria-label="Next"], button:has-text(">"), [class*="next"]:not([disabled])');
    
    if (btnProximo) {
      const disabled = await btnProximo.getAttribute('disabled');
      const ariaDisabled = await btnProximo.getAttribute('aria-disabled');
      
      if (disabled === null && ariaDisabled !== 'true') {
        await btnProximo.click();
        return true;
      }
    }
    
    return false;
    
  } catch (error) {
    return false;
  }
}

// Enviar para webhook
async function enviarParaWebhook(oportunidades) {
  log(`📤 Enviando ${oportunidades.length} oportunidades para o webhook...`);
  
  const payload = {
    source: 'mercado_eletronico',
    timestamp: new Date().toISOString(),
    total: oportunidades.length,
    oportunidades: oportunidades
  };
  
  try {
    const response = await fetch(CONFIG.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Token': CONFIG.scraperToken
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const result = await response.json();
    log('✅ Webhook respondeu:', result);
    return result;
    
  } catch (error) {
    log('❌ Erro ao enviar para webhook:', error.message);
    return null;
  }
}

// Iniciar servidor
app.listen(PORT, () => {
  log(`🚀 API Scraper rodando na porta ${PORT}`);
});
