const Agente = require('../models/agenteModel');

exports.retornarAgente = async (req, res) => {
  try {
    const { id } = req.params;
    const agente = await Agente.findById(id);
    res.json(agente);
  } catch(error) {
    res.status(500).json({ message: error.message });
  }
}

exports.listarAgentes = async (req, res) => {
  try {
    const agentes = await Agente.find();
    res.json(agentes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarAgente = async (req, res) => {
  const agente = new Agente({
    nome: req.body.nome,
    tipo: req.body.tipo,
    documento: req.body.documento
  });

  try {
    const novoAgente = await agente.save();
    res.status(201).json(novoAgente);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarAgente = async (req, res) => {
  const { id } = req.params;

  try {
    const agente = await Agente.findByIdAndUpdate(id, req.body, { new: true });
    res.json(agente);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirAgente = async (req, res) => {
  const { id } = req.params;

  try {
    await Agente.findByIdAndDelete(id);
    res.json({ message: 'Agente excluído com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
