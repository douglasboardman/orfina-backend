const express = require('express');
const router = express.Router();
const pagamentosRegularesController = require('../controllers/pagamentosRegularesController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', pagamentosRegularesController.retornarPagamentoRegular);
router.get('/', pagamentosRegularesController.listarPagamentosRegulares);
router.get('/listarPorAgenteCredor/:agenteCredorId', pagamentosRegularesController.listarPagamentosRegularesPorAgenteCredor);
router.get('/listarPorDescritivo/:descritivoId', pagamentosRegularesController.listarPagamentosRegularesPorDescritivo);
router.get('/listarPorContaOrigem/:contaOrigemId', pagamentosRegularesController.listarPagamentosRegularesPorContaOrigem);
router.post('/', pagamentosRegularesController.criarPagamentoRegular);
router.put('/:id', pagamentosRegularesController.editarPagamentoRegular);
router.delete('/:id', pagamentosRegularesController.excluirPagamentoRegular);

module.exports = router;