const express = require('express');
const router = express.Router();
const cartoesCreditoController = require('../controllers/cartoesCreditoController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', cartoesCreditoController.retornarCartaoCredito);
router.get('/listar', cartoesCreditoController.listarCartoesCredito);
router.get('/listarPorTitular/:titularId', cartoesCreditoController.listarCartoesCreditoPorTitular);
router.post('/', cartoesCreditoController.criarCartaoCredito);
router.put('/:id', cartoesCreditoController.editarCartaoCredito);
router.delete('/:id', cartoesCreditoController.excluirCartaoCredito);

module.exports = router;