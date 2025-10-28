const OpenAI = require('openai').default;
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { db: { schema: 'comercial' } }
);

const LUCIA_ASSISTANT_ID = process.env.LUCIA_ASSISTANT_ID || "asst_503hh6IBKEruuJW4gSYeiFLp";

// ========= FUNÇÃO 1: BUSCAR PREÇO FINAL (WEV) =========
async function buscar_preco_final({ nome_produto, quantidade, areas_personalizacao }) {
  console.log(`--> buscar_preco_final: ${nome_produto}, ${quantidade}, ${areas_personalizacao} áreas`);
  try {
    const { data: produtoData, error: produtoError } = await supabase
      .from('produtos')
      .select('sku_base')
      .ilike('nome_produto', `%${nome_produto}%`)
      .single();

    if (produtoError || !produtoData) {
      return JSON.stringify({ error: "Produto não encontrado." });
    }

    const { data: precoData, error: precoError } = await supabase
      .from('precos')
      .select('preco_unitario')
      .eq('produto_sku', produtoData.sku_base)
      .eq('num_areas', areas_personalizacao)
      .lte('quantidade_min', quantidade)
      .gte('quantidade_max', quantidade)
      .single();

    if (precoError || !precoData) {
      return JSON.stringify({ error: "Não foi possível encontrar um preço para esta combinação." });
    }

    return JSON.stringify({ preco_final: precoData.preco_unitario });
  } catch (e) {
    console.error("Erro em buscar_preco_final:", e);
    return JSON.stringify({ error: "Ocorreu um erro interno ao buscar o preço." });
  }
}

// ========= FUNÇÃO 2: BUSCAR ESTOQUE SPOT =========
async function buscar_estoque_spot({ nome_produto, quantidade }) {
  console.log(`--> buscar_estoque_spot: ${nome_produto}, quantidade: ${quantidade}`);
  try {
    let { data: produtoData, error: produtoError } = await supabase
      .from('spot_produtos')
      .select('id, referencia_spot, nome_produto, descricao_curta, preco_custo_base')
      .eq('referencia_spot', nome_produto)
      .maybeSingle();

    if (!produtoData && !produtoError) {
      const { data: produtoData2, error: produtoError2 } = await supabase
        .from('spot_produtos')
        .select('id, referencia_spot, nome_produto, descricao_curta, preco_custo_base')
        .ilike('nome_produto', `%${nome_produto}%`)
        .maybeSingle();
      produtoData = produtoData2;
      produtoError = produtoError2;
    }

    if (produtoError || !produtoData) {
      return JSON.stringify({ error: "Produto não encontrado no catálogo Spot." });
    }

    const { data: precoData, error: precoError } = await supabase
      .from('spot_precos')
      .select('preco_unitario, quantidade_minima, quantidade_maxima')
      .eq('produto_id', produtoData.id)
      .lte('quantidade_minima', quantidade)
      .gte('quantidade_maxima', quantidade)
      .maybeSingle();

    if (precoError || !precoData) {
      return JSON.stringify({ error: "Preço não disponível para esta quantidade." });
    }

    const precoTotal = precoData.preco_unitario * quantidade;

    return JSON.stringify({
      referencia: produtoData.referencia_spot,
      nome: produtoData.nome_produto,
      descricao: produtoData.descricao_curta,
      quantidade_solicitada: quantidade,
      preco_unitario: precoData.preco_unitario,
      preco_total: precoTotal,
      disponivel: true
    });
  } catch (e) {
    console.error("Erro em buscar_estoque_spot:", e);
    return JSON.stringify({ error: "Ocorreu um erro interno ao buscar o produto Spot." });
  }
}

// ========= FUNÇÃO 3: FINALIZAR QUALIFICAÇÃO =========
async function finalizar_qualificacao({ classificacao, resumo }) {
  console.log(`--> finalizar_qualificacao: ${classificacao}`);
  try {
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      return JSON.stringify({ status: "sucesso", mensagem: "Qualificação registrada." });
    }
    await axios.post(webhookUrl, { classificacao, resumo });
    return JSON.stringify({ status: "sucesso", mensagem: "Lead enviado para a equipe." });
  } catch (e) {
    console.error("Erro em finalizar_qualificacao:", e);
    return JSON.stringify({ error: "Ocorreu um erro ao notificar a equipe." });
  }
}

const tools = { buscar_preco_final, buscar_estoque_spot, finalizar_qualificacao };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let currentThreadId = req.body.threadId;
  const message = req.body.message;

  try {
    if (!currentThreadId) {
      const thread = await openai.beta.threads.create();
      currentThreadId = thread.id;
    }

    await openai.beta.threads.messages.create(currentThreadId, { 
      role: 'user', 
      content: message 
    });

    let run = await openai.beta.threads.runs.create(currentThreadId, {
      assistant_id: LUCIA_ASSISTANT_ID,
    });

    while (['queued', 'in_progress', 'requires_action'].includes(run.status)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      run = await openai.beta.threads.runs.retrieve(run.id, { thread_id: currentThreadId });

      if (run.status === 'requires_action') {
        const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
        const toolOutputs = [];
        
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          
          if (tools[functionName]) {
            const output = await tools[functionName](args);
            toolOutputs.push({ tool_call_id: toolCall.id, output: output });
          }
        }
        
        run = await openai.beta.threads.runs.submitToolOutputs(run.id, { 
          thread_id: currentThreadId, 
          tool_outputs: toolOutputs 
        });
      }
    }

    if (run.status === 'completed') {
      const messages = await openai.beta.threads.messages.list(currentThreadId);
      const lastMessageForRun = messages.data
        .filter(msg => msg.run_id === run.id && msg.role === 'assistant')
        .pop();
      
      return res.status(200).json({ 
        response: lastMessageForRun.content[0].text.value, 
        threadId: currentThreadId 
      });
    } else {
      return res.status(500).json({ 
        error: "A IA não conseguiu completar a requisição.", 
        details: run.last_error 
      });
    }
  } catch (error) {
    console.error("Erro em /api/lucia:", error);
    return res.status(500).json({ 
      error: "Ocorreu um erro crítico.", 
      message: error.message 
    });
  }
};

