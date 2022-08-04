class Automation {
  async run(ctx) {
    await linkapi.transaction.start('register-skus-at-mongodb');

    try {
      const VtexComponent = new linkapi.Component('VtexRestV2', {});
      const vtexmasterdataV2 = new linkapi.Component('vtex-master-data-V2', {});
      const samsungecommercedatabaseV2 = new linkapi.Component('samsung-ecommerce-databaseV2', {});

      const skusCajamarManaus = await vtexmasterdataV2.request('GET', 'dataentities/{dataEntityName}/search', {
        "queryString": {
          "_size": 1000,
          "_fields": "cajamar_reference,manaus_reference"
        },
        "urlParams": {
          "dataEntityName": "RP"
        },
        "headers": {
          "REST-Range": "resources=0-1000"
        }
      });

      const skusBlackList = await vtexmasterdataV2.request('GET', 'dataentities/{dataEntityName}/search', {
        "queryString": {
          "_size": 1000,
          "_fields": "_all"
        },
        "urlParams": {
          "dataEntityName": "SI"
        },
        "headers": {
          "REST-Range": "resources=0-1000"
        }
      });

      let allSkus = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const skus = await VtexComponent.request('GET', 'sku/stockkeepingunitids', {
          "queryString": {
            "page": page,
            "pageSize": 500
          }
        });

        if (!skus.length) {
          hasMore = false;
          break;
        }

        for (const sku of skus) {
          const skuResult = await VtexComponent.request('GET', 'sku/stockkeepingunitbyid/{skuId}', {
            urlParams: {
              skuId: sku
            }
          });

          const { body: { ActivateIfPossible } } = await VtexComponent.request('GET', 'stockkeepingunit/{skuId}', {
            urlParams: {
              skuId: sku
            }
          });

          const skuManaus = skusCajamarManaus.find(
            product => product.cajamar_reference === skuResult.AlternateIds.RefId
              || product.cajamar_reference === skuResult.RefId
          );

          const skuBlackList = skusBlackList.find(
            product => product.SKU === skuManaus
              || product.SKU === skuResult.AlternateIds.RefId
              || product.SKU === skuResult.RefId
          );

          const installationServicesRefId = await linkapi.function.execute(
            'validate-installation-refid', skuResult.AlternateIds.RefId
          );

          if (
            skuResult.AlternateIds.RefId
            && ActivateIfPossible
            && !installationServicesRefId
            && !skuBlackList
          ) {
            allSkus.push(
              {
                ...skuResult,
                RefId: skuManaus || skuResult.AlternateIds.RefId
              }
            );
          }
          else {
            const skuExists = await samsungecommercedatabaseV2.request('GET', 'skus-d2c', {
              queryString: {
                RefId: skuManaus || skuResult.AlternateIds.RefId || skuResult.RefId
              }
            });
            if (skuExists.length > 0) {
              await samsungecommercedatabaseV2.request('DELETE', 'skus-d2c', {
                queryString: {
                  RefId: skuManaus || skuResult.AlternateIds.RefId || skuResult.RefId
                }
              });
            }
          }
        }

        page += 1;
      }

      for (const sku of allSkus) {
        const uniqueKey = sku.RefId;

        await linkapi.transaction.start(uniqueKey)

        try {
          await linkapi.transaction.trace(uniqueKey, {
            status: 'SUCCESS',
            name: 'SKU',
            data: sku
          });

          const skuAlreadyExists = await samsungecommercedatabaseV2.request('GET', 'skus-d2c', {
            queryString: {
              RefId: sku.RefId
            }
          });
          if (skuAlreadyExists.length > 0) {
            await samsungecommercedatabaseV2.request('DELETE', 'skus-d2c', {
              queryString: {
                RefId: sku.RefId
              }
            });
          }

          const response = await samsungecommercedatabaseV2.request('POST', 'skus-d2c', {
            body: sku
          });

          await linkapi.transaction.trace(uniqueKey, {
            status: 'SUCCESS',
            name: 'RESPONSE',
            data: response
          });

          await linkapi.transaction.success(uniqueKey);
        }
        catch (error) {
          await linkapi.transaction.trace(uniqueKey, {
            status: 'ERROR',
            name: 'ERROR TO PROCESS SKU',
            data: {
              message: error.message || error,
              stack: error.stack || null
            }
          });

          await linkapi.transaction.failed(uniqueKey);
        }
      }

      await linkapi.transaction.success('register-skus-at-mongodb');
    }
    catch (error) {
      await linkapi.transaction.trace('register-skus-at-mongodb', {
        status: 'ERROR',
        name: 'ERROR TO PROCESS AUTOMATION',
        data: {
          message: error.message || error,
          stack: error.stack || null
        }
      });

      await linkapi.transaction.failed('register-skus-at-mongodb');
    }
  }
}

module.exports = new Automation();
