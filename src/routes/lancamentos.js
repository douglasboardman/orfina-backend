const express = require('express');
const router = express.Router();
const lancamentosController = require('../controllers/lancamentosController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', lancamentosController.retornarLancamento);
router.get('/listar', lancamentosController.listarLancamentos);
router.get('/listarPorConta/:contaId', lancamentosController.listarPorConta);
router.get('/listarPorCartaoCredito/:cartaoCreditoId', lancamentosController.listarPorCartaoCredito);
router.get('/listarPorDescritivo/:descritivoId', lancamentosController.listarPorDescritivo);
router.post('/', lancamentosController.criarLancamento);
router.put('/:id', lancamentosController.editarLancamento);
router.delete('/:id', lancamentosController.excluirLancamento);

module.exports = router;