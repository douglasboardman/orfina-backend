const Conta = require('../models/contaModel');

exports.retornarConta = async (req, res) => {
  try {
    const {id} = req.params;
    const conta = await Conta.findById(id);
    res.json(conta);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

exports.listarContas = async (req, res) => {
  try {
    const contas = await Conta.find().populate('titular');
    res.json(contas);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarContasPorTitular = async (req, res) => {
  const { titularId } = req.params;

  try {
    const contas = await Conta.find({ titular: titularId });
    res.json(contas);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarConta = async (req, res) => {
  const conta = new Conta({
    nome: req.body.nome,
    tipo: req.body.tipo,
    banco: req.body.banco,
    conta: req.body.conta,
    agencia: req.body.agencia,
    ativo: req.body.ativo || true,
    titular: req.body.titular
  });

  try {
    const novaConta = await conta.save();
    res.status(201).json(novaConta);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarConta = async (req, res) => {
  const { id } = req.params;

  try {
    const conta = await Conta.findByIdAndUpdate(id, req.body, { new: true });
    res.json(conta);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirConta = async (req, res) => {
  const { id } = req.params;

  try {
    await Conta.findByIdAndDelete(id);
    res.json({ message: 'Conta excluída com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};