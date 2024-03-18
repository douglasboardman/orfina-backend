const PagamentoRegular = require('../models/pagamentoRegularModel');

exports.retornarPagamentoRegular = async (req, res) => {
  try {
    const {id} = req.params;
    const pagamentoRegular = await PagamentoRegular.findById(id);
    res.json(pagamentoRegular);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarPagamentosRegulares = async (req, res) => {
  try {
    const pagamentosRegulares = await PagamentoRegular.find().populate(['agente_credor', 'conta_origem', 'descritivo']);
    res.json(pagamentosRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarPagamentosRegularesPorAgenteCredor = async (req, res) => {
  const { agenteCredorId } = req.params;

  try {
    const pagamentosRegulares = await PagamentoRegular.find({ agente_credor: agenteCredorId }).populate(['agente_credor', 'conta_origem', 'descritivo']);
    res.json(pagamentosRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarPagamentosRegularesPorDescritivo = async (req, res) => {
  const { descritivoId } = req.params;

  try {
    const pagamentosRegulares = await PagamentoRegular.find({ descritivo: descritivoId }).populate(['agente_credor', 'conta_origem', 'descritivo']);
    res.json(pagamentosRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarPagamentosRegularesPorContaOrigem = async (req, res) => {
  const { contaOrigemId } = req.params;

  try {
    const pagamentosRegulares = await PagamentoRegular.find({ conta_origem: contaOrigemId }).populate(['agente_credor', 'conta_origem', 'descritivo']);
    res.json(pagamentosRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarPagamentoRegular = async (req, res) => {
  const pagamentoRegular = new PagamentoRegular({
    descricao: req.body.descricao,
    valor_base: req.body.valor_base,
    data_base: req.body.data_base,
    validade: req.body.validade,
    ativo: req.body.ativo || true,
    agente_credor: req.body.agente_credor,
    conta_origem: req.body.conta_origem,
    descritivo: req.body.descritivo,
  });

  try {
    const novoPagamentoRegular = await pagamentoRegular.save();
    res.status(201).json(novoPagamentoRegular);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarPagamentoRegular = async (req, res) => {
  const { id } = req.params;

  try {
    const pagamentoRegular = await PagamentoRegular.findByIdAndUpdate(id, req.body, { new: true }).populate(['agente_credor', 'conta_origem', 'descritivo']);
    res.json(pagamentoRegular);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirPagamentoRegular = async (req, res) => {
  const { id } = req.params;

  try {
    await PagamentoRegular.findByIdAndDelete(id);
    res.json({ message: 'Pagamento regular excluído com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};