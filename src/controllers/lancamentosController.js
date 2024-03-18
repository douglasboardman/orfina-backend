const Lancamento = require('../models/lancamentoModel');

exports.retornarLancamento = async (req, res) => {
  try {
    const { id } = req.params;
    const lancamento = await Lancamento.findById(id);
    res.json(lancamento);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarLancamentos = async (req, res) => {
  try {
    const lancamentos = await Lancamento.find().populate(['descritivo', 'cartao_credito', 'conta']);
    res.json(lancamentos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarLancamento = async (req, res) => {
  const lancamento = new Lancamento({
    tipo: req.body.tipo,
    descritivo: req.body.descritivo,
    descricao: req.body.descricao,
    cartao_credito: req.body.cartao_credito,
    incidencia: req.body.incidencia,
    parcela_atual: req.body.parcela_atual,
    total_parcelas: req.body.total_parcelas,
    conta: req.body.conta,
    data_lancamento: req.body.data_lancamento,
    valor: req.body.valor,
  });

  try {
    const novoLancamento = await lancamento.save();
    res.status(201).json(novoLancamento);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarLancamento = async (req, res) => {
  const { id } = req.params;

  try {
    const lancamento = await Lancamento.findByIdAndUpdate(id, req.body, { new: true }).populate(['descritivo', 'cartao_credito', 'conta']);
    res.json(lancamento);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirLancamento = async (req, res) => {
  const { id } = req.params;

  try {
    await Lancamento.findByIdAndDelete(id);
    res.json({ message: 'Lancamento excluído com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.listarPorDescritivo = async (req, res) => {
  const { descritivoId } = req.params;

  try {
    const lancamentos = await Lancamento.find({ descritivo: descritivoId }).populate(['descritivo', 'cartao_credito', 'conta']);
    res.json(lancamentos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarPorCartaoCredito = async (req, res) => {
  const { cartaoCreditoId } = req.params;

  try {
    const lancamentos = await Lancamento.find({ cartao_credito: cartaoCreditoId }).populate(['descritivo', 'cartao_credito', 'conta']);
    res.json(lancamentos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarPorConta = async (req, res) => {
  const { contaId } = req.params;

  try {
    const lancamentos = await Lancamento.find({ conta: contaId }).populate(['descritivo', 'cartao_credito', 'conta']);
    res.json(lancamentos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
