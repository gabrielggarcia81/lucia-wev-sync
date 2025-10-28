// lucia.js - Versão Atualizada com Busca de Produtos Spot

require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());
const openai = new OpenAI();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    db: { schema: 'comercial' },
});

// --- ID DO ASSISTENTE "LUCIA" ---
const LUCIA_ASSISTANT_ID = "asst_503hh6IBKEruuJW4gSYeiFLp"; // ID da Lucia v1.0

// --- Funções das Ferramentas (completas) ---

// ========= FUNÇÃO 1: BUSCAR PREÇO FINAL (WEV) =========
async function buscar_preco_final({ nome_produto, quantidade, areas_personalizacao }) {
    console.log(`--> Chamando função: buscar_preco_final com: ${nome_produto}, ${quantidade}, ${areas_personalizacao} áreas`);
    try {
        // Consulta 1: Busca o SKU do produto na tabela 'produtos'
        const { data: produtoData, error: produtoError } = await supabase
            .from('produtos')
            .select('sku_base')
            .ilike('nome_produto', `%${nome_produto}%`)
            .single();

        if (produtoError || !produtoData) {
            console.error("Erro ao buscar produto:", produtoError);
            return JSON.stringify({ error: "Produto não encontrado." });
        }

        const produtoSku = produtoData.sku_base;

        // Consulta 2: Busca o preço na tabela 'precos' usando o SKU
        const { data: precoData, error: precoError } = await supabase
            .from('precos')
            .select('preco_unitario')
            .eq('produto_sku', produtoSku)
            .eq('num_areas', areas_personalizacao)
            .lte('quantidade_min', quantidade)
            .gte('quantidade_max', quantidade)
            .single();

        if (precoError || !precoData) {
            console.error("Erro ao buscar preço:", precoError);
            return JSON.stringify({ error: "Não foi possível encontrar um preço para esta combinação." });
        }

        const precoFinal = precoData.preco_unitario;
        console.log(`<-- Retorno da função: Preço final encontrado: R$ ${precoFinal}`);
        return JSON.stringify({ preco_final: precoFinal });

    } catch (e) {
        console.error("Erro inesperado na função buscar_preco_final:", e);
        return JSON.stringify({ error: "Ocorreu um erro interno ao buscar o preço." });
    }
}
// ========= FIM FUNÇÃO 1 =========

// ========= FUNÇÃO 2: BUSCAR ESTOQUE SPOT (NOVO) =========
async function buscar_estoque_spot({ nome_produto, quantidade }) {
    console.log(`--> Chamando função: buscar_estoque_spot com: ${nome_produto}, quantidade: ${quantidade}`);
    try {
        // Consulta 1: Busca o produto na tabela 'spot_produtos'
        // Primeiro tenta por referência exata
        let { data: produtoData, error: produtoError } = await supabase
            .from('spot_produtos')
            .select('id, referencia_spot, nome_produto, descricao_curta, preco_custo_base')
            .eq('referencia_spot', nome_produto)
            .maybeSingle();

        // Se não encontrar, tenta por nome (substring)
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
            console.error("Erro ao buscar produto Spot:", produtoError);
            return JSON.stringify({ error: "Produto não encontrado no catálogo Spot." });
        }

        const produtoId = produtoData.id;
        const referenciaProduto = produtoData.referencia_spot;

        // Consulta 2: Busca o preço na tabela 'spot_precos' para a quantidade solicitada
        const { data: precoData, error: precoError } = await supabase
            .from('spot_precos')
            .select('preco_unitario, quantidade_minima, quantidade_maxima')
            .eq('produto_id', produtoId)
            .lte('quantidade_minima', quantidade)
            .gte('quantidade_maxima', quantidade)
            .maybeSingle();

        if (precoError || !precoData) {
            console.error("Erro ao buscar preço Spot:", precoError);
            return JSON.stringify({ error: "Preço não disponível para esta quantidade." });
        }

        const precoUnitario = precoData.preco_unitario;
        const precoTotal = precoUnitario * quantidade;

        console.log(`<-- Retorno da função: Produto Spot encontrado - R$ ${precoUnitario} (unitário), R$ ${precoTotal} (total)`);
        return JSON.stringify({
            referencia: referenciaProduto,
            nome: produtoData.nome_produto,
            descricao: produtoData.descricao_curta,
            quantidade_solicitada: quantidade,
            preco_unitario: precoUnitario,
            preco_total: precoTotal,
            disponivel: true
        });

    } catch (e) {
        console.error("Erro inesperado na função buscar_estoque_spot:", e);
        return JSON.stringify({ error: "Ocorreu um erro interno ao buscar o produto Spot." });
    }
}
// ========= FIM FUNÇÃO 2 =========

// ========= FUNÇÃO 3: FINALIZAR QUALIFICAÇÃO =========
async function finalizar_qualificacao({ classificacao, resumo }) {
    console.log(`--> Chamando função: finalizar_qualificacao com: ${classificacao}`);
    try {
        const webhookUrl = process.env.N8N_WEBHOOK_URL;
        if (!webhookUrl) {
            console.log("AVISO: N8N_WEBHOOK_URL não configurada. Pulando notificação.");
            return JSON.stringify({ status: "sucesso", mensagem: "Qualificação registrada, mas notificação pulada." });
        }
        await axios.post(webhookUrl, { classificacao, resumo });
        console.log("<-- Retorno da função: Webhook do n8n chamado com sucesso via axios.");
        return JSON.stringify({ status: "sucesso", mensagem: "Lead enviado para a equipe." });
    } catch (e) {
        console.error("Erro ao chamar o webhook do n8n com axios:", e.message);
        return JSON.stringify({ error: "Ocorreu um erro ao notificar a equipe." });
    }
}
// ========= FIM FUNÇÃO 3 =========

const tools = { buscar_preco_final, buscar_estoque_spot, finalizar_qualificacao };

app.post('/api/chat', async (req, res) => {
    let currentThreadId = req.body.threadId;
    const message = req.body.message;

    try {
        if (!currentThreadId) {
            const thread = await openai.beta.threads.create();
            currentThreadId = thread.id;
        }

        await openai.beta.threads.messages.create(currentThreadId, { role: 'user', content: message });

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
                run = await openai.beta.threads.runs.submitToolOutputs(run.id, { thread_id: currentThreadId, tool_outputs: toolOutputs });
            }
        }

        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(currentThreadId);
            const lastMessageForRun = messages.data.filter(msg => msg.run_id === run.id && msg.role === 'assistant').pop();
            res.json({ response: lastMessageForRun.content[0].text.value, threadId: currentThreadId });
        } else {
            res.status(500).json({ error: "A IA não conseguiu completar a requisição.", details: run.last_error });
        }

    } catch (error) {
        res.status(500).json({ error: "Ocorreu um erro crítico.", message: error.message });
    }
});

app.listen(3000, () => {
    console.log("Servidor da Lucia rodando na porta 3000");
});
