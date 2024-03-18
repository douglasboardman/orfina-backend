const CartaoCredito = require('../models/cartaoCreditoModel');

exports.retornarCartaoCredito = async (req, res) => {
  try {
    const {id} = req.params;
    const cartaoCredito = await CartaoCredito.findById(id);
    res.json(cartaoCredito);
  } catch(error) {
    res.status(500).json({ message: error.message });
  }
}

exports.listarCartoesCredito = async (req, res) => {
  try {
    const cartoesCredito = await CartaoCredito.find().populate('titular');
    res.json(cartoesCredito);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarCartoesCreditoPorTitular = async (req, res) => {
  const { titularId } = req.params;

  try {
    const cartoesCredito = await CartaoCredito.find({ titular: titularId });
    res.json(cartoesCredito);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarCartaoCredito = async (req, res) => {
  const cartaoCredito = new CartaoCredito({
    nome: req.body.nome,
    titular: req.body.titular,
    bandeira: req.body.bandeira,
    operadora: req.body.operadora,
    numero: req.body.numero,
    validade: req.body.validade,
    ativo: req.body.ativo || true
  });

  try {
    const novoCartaoCredito = await cartaoCredito.save();
    res.status(201).json(novoCartaoCredito);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarCartaoCredito = async (req, res) => {
  const { id } = req.params;

  try {
    const cartaoCredito = await CartaoCredito.findByIdAndUpdate(id, req.body, { new: true });
    res.json(cartaoCredito);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirCartaoCredito = async (req, res) => {
  const { id } = req.params;

  try {
    await CartaoCredito.findByIdAndDelete(id);
    res.json({ message: 'Cartão de crédito excluído com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
