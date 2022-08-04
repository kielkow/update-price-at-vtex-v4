class Automation {
  async run(ctx) {
    await linkapi.transaction.start('update-price-at-vtex-v4');

    await linkapi.transaction.trace('update-price-at-vtex-v4', {
      status: 'SUCCESS',
      name: 'HOUR OF START AUTOMATION',
      data: new Date().toISOString()
    });

    let skusUpdatedWithSuccess = [];
    let skusUpdatedWithError = [];

    try {
      const VtexPriceComponent = new linkapi.Component('vtexPrice', {});
      const samsungecommercedatabaseV2 = new linkapi.Component('samsung-ecommerce-databaseV2', {});

      const allTablePrices = await linkapi.function.execute(
        'get-table-prices-vtex-channels-sap'
      );
      const tablePrices = allTablePrices.filter(
        table => ctx.tables.includes(table.vtex_table)
      );

      let skusFromDatabase = await samsungecommercedatabaseV2.request('GET', 'skus-d2c', {});

      let allFormattedSkus = [];
      while (skusFromDatabase.length) {
        allFormattedSkus.push(skusFromDatabase.splice(0, 39));
      }

      // CASO SEJA NECESSÁRIO REPROCESSAR SKUS ESPECIFICOS 
      if (ctx.retry && ctx.retry.length > 0) {
        let allSkusToRetry = [];

        for (const RefId of ctx.retry) {
          const skuToRetry = await samsungecommercedatabaseV2.request('GET', 'skus-d2c', {
            queryString: {
              RefId
            }
          });

          await linkapi.transaction.trace('update-price-at-vtex-v4', {
            status: 'SUCCESS',
            name: 'SKU TO RETRY',
            data: {
              RefId,
              skuToRetry
            }
          });

          if (skuToRetry.length > 0) {
            allSkusToRetry.push(skuToRetry[0]);
          }
        }

        allFormattedSkus = [allSkusToRetry];
      }

      if (!allFormattedSkus.length) {
        await linkapi.transaction.trace('update-price-at-vtex-v4', {
          status: 'EMPTY',
          name: 'NO SKUS TO INTEGRATE',
          data: allFormattedSkus
        });

        return linkapi.transaction.empty('update-price-at-vtex-v4');
      }

      for (const allSkus of allFormattedSkus) {
        try {
          let inputLines = []
          let dtInputLines;

          for (const table of tablePrices) {
            const lines = allSkus.map((sku, index) =>
              `<PTIE_KOMP>
            <!--Optional:-->
            <KPOSN>${(index + 1) * 10}</KPOSN>
            <!--Optional:-->
            <MATNR>${sku.RefId.toUpperCase()}</MATNR>
            <!--Optional:-->
            <WERKS></WERKS>
            <!--Optional:-->
            <BWTAR>${sku.RefId.includes('F-') ? '' : 'A'}</BWTAR>
            <!--Optional:-->
            <MGAME>1</MGAME>
            <!--Optional:-->
            <LGORT></LGORT>
          </PTIE_KOMP>`
            )

            inputLines = inputLines.concat(lines)

            dtInputLines = inputLines.filter((line) => line).join('')
            dtInputLines = dtInputLines.replace(new RegExp("\\n", "g"), "");
            dtInputLines = dtInputLines.replace(new RegExp("\\t", "g"), "");

            if (!dtInputLines) continue;

            const skuPrices = await linkapi.function.execute(
              'get-sku-price-at-sap-v2',
              table.documentType,
              table.vtex_table,
              dtInputLines,
              table.channel_sap
            );

            const skuBasePrices = await linkapi.function.execute(
              'get-sku-price-at-sap-v2',
              table.documentType,
              table.vtex_table,
              dtInputLines,
              6032155
            );

            const skusToIntegrate = skuPrices.map((skuPrice) => {
              const basePrice = skuBasePrices.find((skuBasePrice) => skuBasePrice.sku === skuPrice.sku);

              return {
                basePrice: basePrice.price,
                price: skuPrice.price,
                id: skuPrice.sku,
                vtexTable: skuPrice.vtexTable,
                uniqueKey: skuPrice.uniqueKey
              }
            });

            await linkapi.parallel(skusToIntegrate, {
              parallelExecutions: 10,
              transaction: {
                create: false,
                removeDuplicates: false,
                uniqueKey: 'uniqueKey',
                data: '{{product}}'
              }
            }, async (product, uniqueKey) => {
              await linkapi.transaction.start(uniqueKey);

              try {
                await linkapi.transaction.trace(uniqueKey, {
                  status: 'SUCCESS',
                  name: 'SKU TO INTEGRATE',
                  data: product
                });

                const sku = allSkus.find(
                  (sku) => product.id === sku.RefId.toUpperCase()
                );

                await linkapi.transaction.trace(uniqueKey, {
                  status: 'SUCCESS',
                  name: 'SKU FROM MONGODB',
                  data: sku
                });

                await linkapi.transaction.trace(uniqueKey, {
                  status: 'SUCCESS',
                  name: 'Starting request to update product price',
                  data: {
                    urlParams: {
                      itemId: sku.Id,
                      priceTableId: product.vtexTable
                    },
                    body: [
                      {
                        value: product.price,
                        listPrice: product.basePrice,
                        minQuantity: 1,
                      }
                    ]
                  }
                });

                const responseSkuPriceVtex = await VtexPriceComponent.request(
                  'POST',
                  'prices/{itemId}/fixed/{priceTableId}',
                  {
                    urlParams: {
                      itemId: sku.Id,
                      priceTableId: product.vtexTable
                    },
                    body: [
                      {
                        value: product.price,
                        listPrice: product.basePrice,
                        minQuantity: 1,
                      }
                    ]
                  }
                );

                await linkapi.transaction.trace(uniqueKey, {
                  status: 'SUCCESS',
                  name: 'Response update product',
                  data: responseSkuPriceVtex
                });

                linkapi.log({
                  message: "success",
                  responseSkuPriceVtex
                });

                skusUpdatedWithSuccess.push(uniqueKey);

                await linkapi.transaction.success(uniqueKey);
              }
              catch (error) {
                skusUpdatedWithError.push(uniqueKey);

                await linkapi.transaction.trace(uniqueKey, {
                  status: 'ERROR',
                  name: 'ERROR TO UPDATE SKU PRICE',
                  data: {
                    message: error.message || error,
                    stack: error.stack || null
                  }
                });

                await linkapi.transaction.failed(uniqueKey);
              }
            });
          }
        }
        catch (error) {
          await linkapi.transaction.trace('update-price-at-vtex-v4', {
            status: 'ERROR',
            name: 'ERROR TO PROCESS SKUS',
            data: {
              skus: allSkus.map(sku => sku.RefId),
              message: error.message || error,
              stack: error.stack || null,
            }
          });
        }
      }

      await linkapi.transaction.trace('update-price-at-vtex-v4', {
        status: 'SUCCESS',
        name: 'REPORT',
        data: {
          numberOfSuccess: skusUpdatedWithSuccess.length,
          numberOfError: skusUpdatedWithError.length,
        }
      });

      await linkapi.transaction.trace('update-price-at-vtex-v4', {
        status: 'SUCCESS',
        name: 'HOUR OF END AUTOMATION',
        data: new Date().toISOString()
      });

      await linkapi.transaction.success('update-price-at-vtex-v4');
    }
    catch (error) {
      await linkapi.transaction.trace('update-price-at-vtex-v4', {
        status: 'ERROR',
        name: 'ERROR TO PROCESS AUTOMATION',
        data: {
          message: error.message || error,
          stack: error.stack || null
        }
      });

      await linkapi.transaction.failed('update-price-at-vtex-v4');
    }
  }
}
